/**
 * King-CrackX —— detector 拆分：Vue 框架检测与路由分析
 *
 * 不是独立注入脚本，由 detector.ts 唯一入口 import，最终打包进单个自包含 IIFE `detector.js`。
 * 本模块只负责 Vue（Vue 2 / 3 + Vue Router 2/3/4）这一侧：根实例定位、Router 定位、
 * 路由枚举、鉴权 meta 改写、守卫清除、完整分析流程。React 侧见 detector-react.ts。
 *
 * 函数体逐字保留自原 detector.js，仅改为跨模块可见：
 *   - 对外暴露 findVueRoot（入口 detectFramework 需要）与 performFullAnalysis（入口分析分发需要）
 *   - 其余辅助函数在本模块内闭环，保持模块私有
 *   - 错误处理 / 控制台恢复 / 页面链接分析复用 detector-shared
 */

import { analyzePageLinks, handleError, restoreConsole, type ConsoleOriginals } from './detector-shared';

/* ==================== Vue 根实例与版本 ==================== */

/**
 * 广度优先查找 Vue 根实例（兼容 Vue2 / Vue3）。
 *
 * 判定依据：元素上挂有以下任一属性即认为是 Vue 挂载点
 *   - __vue_app__ ：Vue 3 应用实例
 *   - __vue__     ：Vue 2 组件实例
 *   - _vnode      ：Vue 内部虚拟节点引用
 *
 * 用广度优先而非递归，是为了优先在浅层命中，减少无效遍历；
 * maxDepth 限制防止极端深度的 DOM 造成栈/时间开销失控。
 *
 * @param root - 遍历起点，通常为 document.body
 * @param maxDepth - 最大遍历深度
 * @returns Vue 根节点；未找到时为 null
 */
export function findVueRoot(root: Node, maxDepth: number = 1000): VueElementLike | null {
    const queue: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
    while (queue.length) {
        const { node, depth } = queue.shift() as { node: Node; depth: number };
        if (depth > maxDepth) break;

        const element = node as VueElementLike;
        if (element.__vue_app__ || element.__vue__ || element._vnode) {
            return element;
        }

        // 只向下遍历元素节点，其子节点入队并累加深度
        if (node.nodeType === 1 && node.childNodes) {
            for (let i = 0; i < node.childNodes.length; i++) {
                queue.push({ node: node.childNodes[i], depth: depth + 1 });
            }
        }
    }
    return null;
}

/**
 * 获取 Vue 版本号。
 *
 * 按可信度依次尝试四个来源：
 *   1. Vue 3 的 __vue_app__.version
 *   2. Vue 2 的 $options._base.version
 *   3. 全局 window.Vue.version
 *   4. Vue DevTools 钩子上的 Vue 版本（生产环境常有）
 *
 * @param vueRoot - Vue 根节点
 * @returns 版本号字符串；无法确定时返回 'unknown'
 */
function getVueVersion(vueRoot: VueElementLike): string {
    let version: string | undefined =
        vueRoot.__vue_app__?.version ||
        vueRoot.__vue__?.$root?.$options?._base?.version;

    if (!version || version === 'unknown') {
        // 尝试从全局Vue对象获取
        if (window.Vue && window.Vue.version) {
            version = window.Vue.version;
        }
        // 尝试从Vue DevTools获取
        else if (window.__VUE_DEVTOOLS_GLOBAL_HOOK__ &&
            window.__VUE_DEVTOOLS_GLOBAL_HOOK__.Vue) {
            version = window.__VUE_DEVTOOLS_GLOBAL_HOOK__.Vue.version;
        }
    }

    return version || 'unknown';
}

/* ==================== Vue Router 相关函数 ==================== */

/**
 * 从 Vue 根节点上定位 Vue Router 实例。
 *
 * Vue 3（Router 4）路径，依次尝试：
 *   - app.config.globalProperties.$router
 *   - app._instance.appContext.config.globalProperties.$router
 *   - app._instance.ctx.$router
 * Vue 2（Router 2/3）路径，依次尝试：
 *   - vue.$router / vue.$root.$router / vue.$root.$options.router / vue._router
 *
 * 之所以要尝试多个来源，是因为不同构建方式（完整版/运行时版）
 * 与不同 Router 版本挂载 $router 的位置存在差异。
 *
 * @param vueRoot - Vue 根节点
 * @returns Vue Router 实例；未找到时为 null
 */
function findVueRouter(vueRoot: VueElementLike): VueRouterLike | null {
    try {
        if (vueRoot.__vue_app__) {
            // Vue3 + Router4
            const app = vueRoot.__vue_app__;

            if (app.config?.globalProperties?.$router) {
                return app.config.globalProperties.$router as VueRouterLike;
            }

            const instance = app._instance;
            if (instance?.appContext?.config?.globalProperties?.$router) {
                return instance.appContext.config.globalProperties.$router as VueRouterLike;
            }

            if (instance?.ctx?.$router) {
                return instance.ctx.$router as VueRouterLike;
            }
        }

        if (vueRoot.__vue__) {
            // Vue2 + Router2/3
            const vue = vueRoot.__vue__;
            return vue.$router ||
                vue.$root?.$router ||
                vue.$root?.$options?.router ||
                vue._router ||
                null;
        }
    } catch (e) {
        handleError(e, 'findVueRouter');
    }
    return null;
}

/**
 * 递归遍历路由数组及其所有嵌套子路由。
 *
 * @param routes - 路由数组
 * @param cb - 对每个路由调用的回调
 */
function walkRoutes(routes: RouteConfigLike[] | undefined, cb: (route: RouteConfigLike) => void): void {
    if (!Array.isArray(routes)) return;
    routes.forEach(route => {
        cb(route);
        // 递归处理子路由，覆盖嵌套路由表
        if (Array.isArray(route.children) && route.children.length) {
            walkRoutes(route.children, cb);
        }
    });
}

/**
 * 判断 meta 字段值是否表示「真」（即需要鉴权）。
 * 兼容布尔、字符串、数字三种书写形式。
 *
 * @param val - meta 字段值
 * @returns true 表示该字段要求鉴权
 */
function isAuthTrue(val: unknown): boolean {
    return val === true || val === 'true' || val === 1 || val === '1';
}

/**
 * 拼接父子路由路径，得到完整路由路径。
 *
 * 规则：
 *   - 子路径为空则沿用父路径
 *   - 子路径以 / 开头视为绝对路径，直接返回（Vue Router 的嵌套语义）
 *   - 否则与父路径用 / 拼接，并处理父路径结尾的斜杠
 *
 * @param base - 父级路径
 * @param path - 子级路径
 * @returns 拼接后的完整路径
 */
function joinPath(base: string, path?: string): string {
    if (!path) return base || '/';
    if (path.startsWith('/')) return path;
    if (!base || base === '/') return '/' + path;
    return (base.endsWith('/') ? base.slice(0, -1) : base) + '/' + path;
}

/**
 * 提取 Router 的基础路径（base）。
 *
 * 基础路径是部署在子目录时的前缀，例如部署在 /admin/ 下时为 '/admin'。
 * 优先取用户显式配置的 router.options.base，其次取 history.base。
 * 该值可信度最高，popup 会用它生成「带基础路径」的 URL。
 *
 * @param router - Vue Router 实例
 * @returns 基础路径；未配置时为空字符串
 */
function extractRouterBase(router: VueRouterLike): string {
    try {
        if (router.options?.base) {
            return router.options.base;
        }
        if (router.history?.base) {
            return router.history.base;
        }
        return '';
    } catch (e) {
        handleError(e, '提取Router基础路径');
        return '';
    }
}

/**
 * 改写所有路由 meta 中的鉴权字段，使前端路由级鉴权失效。
 *
 * 仅针对 key 中含 "auth" 且值为真的字段（如 meta.requiresAuth）。
 * 注意：此处的判定范围比 all-in.js 中的版本更保守（只认 auth），
 * 属于「温和模式」；梭哈模式才是全面接管。
 *
 * 兼容三种路由表来源：getRoutes()（Router4）、options.routes（Router2/3）、
 * matcher（内部匹配器）。
 *
 * @param router - Vue Router 实例
 * @returns 被修改的路由清单，供 popup 展示
 */
function patchAllRouteAuth(router: VueRouterLike): ModifiedRoute[] {
    const modified: ModifiedRoute[] = [];

    /**
     * 改写单条路由的 meta 鉴权字段。
     * @param route - 路由对象
     */
    function patchMeta(route: RouteConfigLike): void {
        if (route.meta && typeof route.meta === 'object') {
            Object.keys(route.meta).forEach(key => {
                if (key.toLowerCase().includes('auth') && isAuthTrue(route.meta?.[key])) {
                    (route.meta as Record<string, any>)[key] = false;
                    modified.push({ path: route.path, name: route.name });
                }
            });
        }
    }

    try {
        if (typeof router.getRoutes === 'function') {
            router.getRoutes().forEach(patchMeta);
        }
        else if (router.options?.routes) {
            walkRoutes(router.options.routes, patchMeta);
        }
        else if (router.matcher) {
            if (typeof router.matcher.getRoutes === 'function') {
                router.matcher.getRoutes().forEach(patchMeta);
            }
            else if (router.matcher.match && router.history?.current?.matched) {
                router.history.current.matched.forEach(patchMeta);
            }
        }
        else {
            console.warn('🚫 未识别的 Vue Router 版本，跳过 Route Auth Patch');
        }
    } catch (e) {
        handleError(e, 'patchAllRouteAuth');
    }

    if (modified.length) {
        console.log('🚀 已修改的路由 auth meta：');
        console.table(modified);
    } else {
        console.log('ℹ️ 没有需要修改的路由 auth 字段');
    }

    return modified;
}

/**
 * 清除路由守卫（温和模式）。
 *
 * 两步处理：
 *   1. 把 beforeEach / beforeResolve / afterEach 替换为空函数，阻断后续注册
 *   2. 清空已知的守卫容器数组，移除接管前已注册的守卫
 *
 * 与 all-in.js 的强拦截相比，本函数不做原型级接管、
 * 不 hook Array.prototype.push，属于一次性清理。
 *
 * @param router - Vue Router 实例
 */
function patchRouterGuards(router: VueRouterLike): void {
    try {
        ['beforeEach', 'beforeResolve', 'afterEach'].forEach(hook => {
            if (typeof router[hook] === 'function') {
                router[hook] = () => {};
            }
        });

        const guardProps = [
            'beforeGuards', 'beforeResolveGuards', 'afterGuards',
            'beforeHooks', 'resolveHooks', 'afterHooks'
        ];

        guardProps.forEach(prop => {
            const container = router[prop];
            if (Array.isArray(container)) {
                container.length = 0;
            }
        });

        console.log('✅ 路由守卫已清除');
    } catch (e) {
        handleError(e, 'patchRouterGuards');
    }
}

/**
 * 枚举 Router 中的全部路由。
 *
 * 按优先级尝试四种数据来源（覆盖不同版本与不同暴露程度）：
 *   1. getRoutes()                —— Vue Router 4 标准接口
 *   2. options.routes             —— Vue Router 2/3 原始配置（需递归拼路径）
 *   3. matcher.getRoutes()        —— 内部匹配器
 *   4. history.current.matched    —— 兜底：至少拿到当前匹配链
 *
 * @param router - Vue Router 实例
 * @returns 路由清单
 */
function listAllRoutes(router: VueRouterLike): RouteEntry[] {
    const list: RouteEntry[] = [];

    try {
        // Vue Router 4
        if (typeof router.getRoutes === 'function') {
            router.getRoutes().forEach(r => {
                list.push({
                    name: r.name,
                    path: r.path,
                    meta: r.meta
                });
            });
            return list;
        }

        // Vue Router 2/3
        if (router.options?.routes) {
            /**
             * 递归遍历路由配置，把嵌套子路由展开为完整路径。
             * @param routes - 路由配置数组
             * @param basePath - 父级路径，用于拼接
             */
            function traverse(routes: RouteConfigLike[], basePath: string = ''): void {
                routes.forEach(r => {
                    const fullPath = joinPath(basePath, r.path);
                    list.push({ name: r.name, path: fullPath, meta: r.meta });
                    if (Array.isArray(r.children) && r.children.length) {
                        traverse(r.children, fullPath);
                    }
                });
            }
            traverse(router.options.routes);
            return list;
        }

        // 从matcher获取
        if (router.matcher?.getRoutes) {
            const routes = router.matcher.getRoutes();
            routes.forEach(r => {
                list.push({ name: r.name, path: r.path, meta: r.meta });
            });
            return list;
        }

        // 从历史记录获取
        if (router.history?.current?.matched) {
            router.history.current.matched.forEach(r => {
                list.push({ name: r.name, path: r.path, meta: r.meta });
            });
            return list;
        }

        console.warn('🚫 无法列出路由信息');
    } catch (e) {
        handleError(e, 'listAllRoutes');
    }

    return list;
}

/* ==================== 完整分析函数 ==================== */

/**
 * 执行完整的 Vue / Router 分析（Vue 侧核心流程）。
 *
 * 执行步骤：
 *   1. 临时拦截 console 输出，把分析过程中的日志一并收集进结果
 *      （便于 popup 侧排查，同时不影响页面控制台原有输出）
 *   2. 查找 Vue 根实例；未找到则提前返回
 *   3. 定位 Vue Router 实例；未找到则提前返回
 *   4. 读取 Vue 版本、Router 基础路径
 *   5. 分析页面链接推测候选基础路径
 *   6. 改写鉴权 meta 并清除路由守卫
 *   7. 枚举全部路由
 * 无论成功或异常，都会恢复被接管的 console 方法。
 *
 * @returns 分析结果
 */
export function performFullAnalysis(): RouterAnalysisResult {
    const result: FullRouterAnalysis = {
        vueDetected: false,
        framework: 'vue',
        vueVersion: null,
        routerDetected: false,
        logs: [],
        modifiedRoutes: [],
        allRoutes: [],
        routerBase: '',
        pageAnalysis: {
            detectedBasePath: '',
            commonPrefixes: []
        },
        currentPath: window.location.pathname
    };

    // 保存原始控制台函数
    const originals: ConsoleOriginals = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        table: console.table
    };

    try {
        // 拦截控制台输出
        console.log = function (...args: any[]) {
            result.logs.push({ type: 'log', message: args.join(' ') });
            originals.log.apply(console, args);
        };
        console.warn = function (...args: any[]) {
            result.logs.push({ type: 'warn', message: args.join(' ') });
            originals.warn.apply(console, args);
        };
        console.error = function (...args: any[]) {
            result.logs.push({ type: 'error', message: args.join(' ') });
            originals.error.apply(console, args);
        };
        console.table = function (data?: any, columns?: string[]) {
            if (Array.isArray(data)) {
                result.logs.push({ type: 'table', data: [...data] });
            } else {
                result.logs.push({ type: 'table', data: { ...data } });
            }
            originals.table.call(console, data, columns);
        };

        // 查找Vue根实例
        const vueRoot = findVueRoot(document.body);
        if (!vueRoot) {
            console.error('❌ 未检测到 Vue 实例');
            restoreConsole(originals);
            return result;
        }

        result.vueDetected = true;

        // 查找Vue Router
        const router = findVueRouter(vueRoot);
        if (!router) {
            console.error('❌ 未检测到 Vue Router 实例');
            restoreConsole(originals);
            return result;
        }

        result.routerDetected = true;

        // 获取Vue版本
        result.vueVersion = getVueVersion(vueRoot);
        console.log('✅ Vue 版本：', result.vueVersion);

        // 提取Router基础路径
        result.routerBase = extractRouterBase(router);
        console.log('📍 Router基础路径:', result.routerBase || '(无)');

        // 分析页面链接
        result.pageAnalysis = analyzePageLinks();
        if (result.pageAnalysis.detectedBasePath) {
            console.log('🔍 从页面链接检测到基础路径:', result.pageAnalysis.detectedBasePath);
        }

        // 修改路由鉴权元信息并清除导航守卫
        result.modifiedRoutes = patchAllRouteAuth(router);
        patchRouterGuards(router);

        // 列出所有路由
        result.allRoutes = listAllRoutes(router);
        console.log('🔍 当前所有路由：');
        console.table(result.allRoutes);

        restoreConsole(originals);
        return result;

    } catch (error) {
        restoreConsole(originals);
        handleError(error, 'performFullAnalysis', true);
        return {
            vueDetected: false,
            routerDetected: false,
            error: String(error)
        };
    }
}
