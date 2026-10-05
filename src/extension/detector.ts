/**
 * King-CrackX —— 前端框架检测与路由分析器（MAIN world）
 *
 * 由 content.js 按需注入到页面主世界，自动识别页面所用框架（Vue / React），
 * 并按命中的框架走对应的分析流程，用于：
 *   1. 检测页面是否使用 Vue 或 React，并识别版本（Vue 2 / 3；React 17 / 18 / 19）
 *   2. 定位路由实例（Vue Router / React Router），枚举全部路由（含嵌套子路由）
 *   3. 清除路由守卫、改写鉴权 meta，实现前端路由绕过（Vue；React 由 all-in.js 强接管）
 *   4. 分析页面链接，推测 Router 基础路径
 *
 * 无论命中哪个框架，回传消息类型与 Vue 版本保持一致（VUE_DETECTION_RESULT /
 * VUE_ROUTER_ANALYSIS_RESULT），仅在结果对象上多带一个 framework 字段，
 * 因此 content.js / popup 的中转与渲染逻辑无需为大改。
 *
 * 结果通过 window.postMessage 回传给 content.js 中转。
 */
(function () {
    // ======== 通用工具函数 ========

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
    function findVueRoot(root: Node, maxDepth: number = 1000): VueElementLike | null {
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
     * 统一的错误处理。
     *
     * @param error - 捕获到的错误
     * @param context - 出错位置标识，便于定位
     * @param shouldStop - 是否为致命错误。
     *        为 true 时额外向扩展上报错误并返回 false，表示应中止流程。
     * @returns true 表示可继续执行；false 表示流程中断
     */
    function handleError(error: unknown, context: string, shouldStop: boolean = false): boolean {
        const errorMsg = `${context}: ${String(error)}`;
        console.warn(errorMsg);

        if (shouldStop) {
            sendError(errorMsg);
            return false;
        }
        return true;
    }

    /** 被临时接管的控制台方法原始引用 */
    interface ConsoleOriginals {
        log: (...data: any[]) => void;
        warn: (...data: any[]) => void;
        error: (...data: any[]) => void;
        table: (tabularData?: any, properties?: string[]) => void;
    }

    /**
     * 恢复被 performFullAnalysis 临时接管的控制台方法。
     * 必须成对调用，否则会造成 console 永久被改写。
     *
     * @param originals - 保存的原始控制台方法集合
     */
    function restoreConsole(originals: ConsoleOriginals): void {
        console.log = originals.log;
        console.warn = originals.warn;
        console.error = originals.error;
        console.table = originals.table;
    }

    /**
     * 清理 URL 中的冗余斜杠与结尾斜杠，便于比较。
     * 例如 "https://a.com//b/" -> "https://a.com/b"
     * 注意保留协议后的 "://"，只合并路径部分的重复斜杠。
     *
     * @param url - 原始 URL
     * @returns 清理后的 URL
     */
    function cleanUrl(url: string): string {
        return url.replace(/([^:]\/)\/+/g, '$1').replace(/\/$/, '');
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

    // ======== 消息发送函数 ========

    /**
     * 上报框架检测结果。
     * @param result - 形如 { detected: boolean, method: string, framework?: 'vue' | 'react' }
     */
    function sendResult(result: Pick<VueDetectionResult, 'detected' | 'method' | 'framework'>): void {
        window.postMessage({
            type: 'VUE_DETECTION_RESULT',
            result: result
        }, '*');
    }

    /**
     * 上报路由分析结果（含数据清洗与容错）。
     *
     * 关键处理：
     *   1. 归一化 allRoutes 为标准数组结构 [{name, path, meta}]
     *      —— 不同 Router 版本返回的结构不一致（数组/对象/含实例引用）
     *   2. 经 sanitizeForPostMessage 剔除函数、Promise、循环引用等
     *      无法通过 postMessage 结构化克隆的内容
     *
     * postMessage 采用结构化克隆算法，一旦数据中含不可克隆对象会直接抛错，
     * 因此这里是最后一道防线：即便清洗失败，也退化为发送最小可用结果，
     * 保证 popup 至少能拿到检测状态而不是卡在 loading。
     *
     * @param result - performFullAnalysis 产出的原始结果
     */
    function sendRouterResult(result: RouterAnalysisResult): void {
        try {
            // 预处理 - 确保 allRoutes 是正确格式的数组
            let allRoutes: RouteEntry[] = [];
            const rawRoutes: unknown = result.allRoutes;

            if (rawRoutes) {
                if (!Array.isArray(rawRoutes)) {
                    // 如果不是数组，转换为数组
                    if (typeof rawRoutes === 'object') {
                        const routeArray: RouteEntry[] = [];
                        const rawObject = rawRoutes as Record<string, any>;
                        for (const key in rawObject) {
                            if (Object.prototype.hasOwnProperty.call(rawObject, key)) {
                                const route = rawObject[key];
                                if (route && typeof route === 'object') {
                                    routeArray.push({
                                        name: route.name || key,
                                        path: route.path || key,
                                        meta: route.meta || {}
                                    });
                                }
                            }
                        }
                        allRoutes = routeArray;
                    } else {
                        allRoutes = [];
                    }
                } else {
                    // 确保数组中的每个元素都有正确的结构
                    allRoutes = (rawRoutes as any[]).map(route => {
                        if (typeof route === 'object' && route !== null) {
                            return {
                                name: route.name || '',
                                path: route.path || '',
                                meta: route.meta || {}
                            };
                        }
                        return { name: '', path: route || '', meta: {} };
                    });
                }
            }

            result.allRoutes = allRoutes;

            // 序列化清理结果数据
            const sanitizedResult = sanitizeForPostMessage(result);

            window.postMessage({
                type: 'VUE_ROUTER_ANALYSIS_RESULT',
                result: sanitizedResult
            }, '*');
        } catch (error) {
            console.warn('Failed to send router result:', error);
            // 发送最简化版本
            window.postMessage({
                type: 'VUE_ROUTER_ANALYSIS_RESULT',
                result: {
                    vueDetected: result?.vueDetected || false,
                    routerDetected: result?.routerDetected || false,
                    framework: result?.framework || 'vue',
                    vueVersion: result?.vueVersion || 'Unknown',
                    reactVersion: result?.reactVersion || 'Unknown',
                    modifiedRoutes: result?.modifiedRoutes || [],
                    error: 'Serialization failed',
                    allRoutes: []
                }
            }, '*');
        }
    }

    /**
     * 上报路由分析过程中的错误。
     * @param error - 错误描述文本
     */
    function sendError(error: string): void {
        window.postMessage({
            type: 'VUE_ROUTER_ANALYSIS_ERROR',
            error: error
        }, '*');
    }

    // ======== Vue 检测函数 ========

    // 说明：框架探测入口已统一到文件后部的 detectFramework()（先 Vue 后 React）。
    // 这里保留 Vue 根实例的定位实现，供 detectFramework 与 performFullAnalysis 复用。

    // ======== Vue Router相关函数 ========

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

    /** 页面链接缓存：避免重复查询 DOM（一次分析中会多次用到） */
    const linkCache = new Map<string, string[]>();

    /**
     * 获取页面中疑似路由链接的 href 列表（带缓存）。
     *
     * 筛选条件：
     *   - 以 / 开头（站内绝对路径）
     *   - 不以 // 开头（排除协议相对 URL）
     *   - 不含 .（排除带扩展名的静态资源链接）
     *
     * @returns 疑似路由路径列表
     */
    function getCachedLinks(): string[] {
        const cacheKey = 'page-links';
        if (linkCache.has(cacheKey)) {
            return linkCache.get(cacheKey) as string[];
        }

        const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.getAttribute('href'))
            .filter((href): href is string =>
                !!href &&
                href.startsWith('/') &&
                !href.startsWith('//') &&
                !href.includes('.')
            );

        linkCache.set(cacheKey, links);
        return links;
    }

    /**
     * 分析页面链接，推测 Router 的候选基础路径。
     *
     * 思路：统计所有站内链接的第一段路径，若某个前缀占比超过 60%，
     * 则很可能是部署基础路径（如大量链接形如 /admin/xxx）。
     *
     * 结果作为**候选值**：可信度低于 router.options.base，
     * popup 仅在未取到显式 base 时才会考虑使用。
     *
     * @returns 推测出的基础路径与各前缀的命中统计
     */
    function analyzePageLinks(): PageAnalysisResult {
        const result: PageAnalysisResult = {
            detectedBasePath: '',
            commonPrefixes: []
        };

        try {
            const links = getCachedLinks();

            // 样本过少时统计无意义，直接返回空结果
            if (links.length < 3) return result;

            // 取每个链接的第一段路径并计数
            const pathSegments = links.map(link => link.split('/').filter(Boolean));
            const firstSegments: Record<string, number> = {};

            pathSegments.forEach(segments => {
                if (segments.length > 0) {
                    const first = segments[0];
                    firstSegments[first] = (firstSegments[first] || 0) + 1;
                }
            });

            const sortedPrefixes = Object.entries(firstSegments)
                .sort((a, b) => b[1] - a[1])
                .map(entry => ({ prefix: entry[0], count: entry[1] }));

            result.commonPrefixes = sortedPrefixes;

            // 最高频前缀占比超过 60% 才认定为候选基础路径，避免误判
            if (sortedPrefixes.length > 0 &&
                sortedPrefixes[0].count / links.length > 0.6) {
                result.detectedBasePath = '/' + sortedPrefixes[0].prefix;
            }
        } catch (e) {
            handleError(e, '分析页面链接');
        }

        return result;
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
     * 把任意对象清洗为可被 postMessage 结构化克隆的纯数据。
     *
     * 必须清洗的原因：Vue Router 的内部对象含有大量无法克隆的内容
     *   - 函数、Promise        -> 替换为类型标签字符串
     *   - 自定义类实例          -> 替换为 "[类名]"
     *   - 循环引用（parent/router/matched 等）-> 直接跳过
     *
     * 处理策略：
     *   - allRoutes 数组特殊处理，只保留 name / path / meta 三个字段
     *   - 以 _ 或 $ 开头的属性视为内部字段，跳过
     *   - meta / query / params 等浅层对象递归清洗
     *   - 其他深层对象统一替换为 "[Object]"，避免无限递归
     *
     * @param obj - 待清洗的数据
     * @returns 可安全 postMessage 的数据
     */
    function sanitizeForPostMessage(obj: unknown): unknown {
        if (obj === null || obj === undefined) {
            return obj;
        }

        if (typeof obj === 'function') {
            return '[Function]';
        }

        if (obj instanceof Promise) {
            return '[Promise]';
        }

        if (typeof obj === 'object') {
            const source = obj as Record<string, any>;

            if (source.constructor && source.constructor.name &&
                !['Object', 'Array'].includes(source.constructor.name)) {
                return `[${source.constructor.name}]`;
            }

            const sanitized: Record<string, any> = Array.isArray(obj) ? [] : {};

            try {
                for (const key in source) {
                    if (typeof source.hasOwnProperty === 'function' && source.hasOwnProperty(key)) {
                        const value = source[key];

                        // 特殊处理 allRoutes 数组
                        if (key === 'allRoutes' && Array.isArray(value)) {
                            sanitized[key] = value.map(route => {
                                if (typeof route === 'object' && route !== null) {
                                    return {
                                        name: route.name || '',
                                        path: route.path || '',
                                        meta: route.meta ? sanitizeRouteObject(route.meta) : {}
                                    };
                                }
                                return route;
                            });
                            continue;
                        }

                        // 跳过可能导致循环引用的属性
                        if (key.startsWith('_') || key.startsWith('$') ||
                            key === 'parent' || key === 'router' || key === 'matched') {
                            continue;
                        }

                        if (typeof value === 'function') {
                            sanitized[key] = '[Function]';
                        } else if (value instanceof Promise) {
                            sanitized[key] = '[Promise]';
                        } else if (Array.isArray(value)) {
                            // 处理数组 - 检查是否是路由数组
                            if (value.length > 0 && value[0] && typeof value[0] === 'object' && value[0].path !== undefined) {
                                // 这是路由数组
                                sanitized[key] = value.map(item => {
                                    if (typeof item === 'object' && item !== null) {
                                        return {
                                            name: item.name || '',
                                            path: item.path || '',
                                            meta: item.meta ? sanitizeRouteObject(item.meta) : {}
                                        };
                                    }
                                    return item;
                                });
                            } else {
                                // 普通数组
                                sanitized[key] = value.map(item => {
                                    if (typeof item === 'object' && item !== null) {
                                        return sanitizeRouteObject(item);
                                    }
                                    return item;
                                });
                            }
                        } else if (typeof value === 'object' && value !== null) {
                            // 简单对象递归处理，避免深度过大
                            if (key === 'meta' || key === 'query' || key === 'params') {
                                sanitized[key] = sanitizeRouteObject(value);
                            } else {
                                sanitized[key] = '[Object]';
                            }
                        } else {
                            sanitized[key] = value;
                        }
                    }
                }
            } catch (e) {
                return '[Object - Serialization Error]';
            }

            return sanitized;
        }

        return obj;
    }

    /**
     * 专门清洗浅层的路由相关对象（meta / query / params 等）。
     *
     * 与 sanitizeForPostMessage 的区别：本函数**不递归**，
     * 遇到嵌套对象一律替换为 "[Object]"，以此切断潜在的超深结构与循环引用。
     *
     * @param obj - 待清洗的浅层对象
     * @returns 清洗后的对象，值类型只会是原始值或类型标签字符串
     */
    function sanitizeRouteObject(obj: unknown): unknown {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }

        const source = obj as Record<string, any>;
        const sanitized: Record<string, any> = {};

        try {
            for (const key in source) {
                if (typeof source.hasOwnProperty === 'function' && source.hasOwnProperty(key)) {
                    const value = source[key];

                    if (typeof value === 'function') {
                        sanitized[key] = '[Function]';
                    } else if (value instanceof Promise) {
                        sanitized[key] = '[Promise]';
                    } else if (typeof value === 'object' && value !== null) {
                        // 避免深度递归
                        sanitized[key] = '[Object]';
                    } else {
                        sanitized[key] = value;
                    }
                }
            }
        } catch (e) {
            return '[Route Object - Serialization Error]';
        }

        return sanitized;
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

    // ======== 完整分析函数 ========

    /**
     * 执行完整的 Vue / Router 分析（本脚本的核心流程）。
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
    function performFullAnalysis(): RouterAnalysisResult {
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

    // ======== React 检测与路由分析 ========

    /**
     * 在元素上查找以指定前缀开头的属性 key。
     *
     * React 会在 DOM 节点上挂形如 `__reactFiber$<随机后缀>`、
     * `__reactContainer$<随机后缀>`、`__reactProps$<随机后缀>` 的属性，
     * 后缀是每个构建生成的随机字符串，因此只能按前缀匹配，不能写死全名。
     *
     * @param element - 待探测的 DOM 元素
     * @param prefix - 属性名前缀，如 '__reactContainer'
     * @returns 命中的属性名；未命中时为空字符串
     */
    function findKeyByPrefix(element: ReactElementLike, prefix: string): string {
        for (const key in element) {
            if (key.indexOf(prefix) === 0) {
                return key;
            }
        }
        return '';
    }

    /**
     * 广度优先扫描 DOM，定位 React 挂载容器。
     *
     * 判定依据（任一命中即认为是 React 挂载点）：
     *   - `__reactContainer$xxx` ：React 18+ createRoot 挂在根容器上的标记
     *   - `_reactRootContainer`  ：React 17 及以下 ReactDOM.render 的挂载标记
     *   - `__reactFiber$xxx`     ：任意节点上的 Fiber 引用（兜底）
     *
     * 与 Vue 一样采用广度优先，优先在浅层命中，并用 maxDepth 防止超深 DOM 失控。
     *
     * @param root - 遍历起点，通常为 document.body
     * @param maxDepth - 最大遍历深度
     * @returns React 挂载元素；未找到时为 null
     */
    function findReactRoot(root: Node, maxDepth: number = 1000): ReactElementLike | null {
        const queue: Array<{ node: Node; depth: number }> = [{ node: root, depth: 0 }];
        while (queue.length) {
            const { node, depth } = queue.shift() as { node: Node; depth: number };
            if (depth > maxDepth) break;

            const element = node as ReactElementLike;
            if (element.nodeType === 1) {
                // 命中任一 React 标记即认为找到了挂载点
                if (findKeyByPrefix(element, '__reactContainer') ||
                    element._reactRootContainer ||
                    findKeyByPrefix(element, '__reactFiber')) {
                    return element;
                }

                if (node.childNodes) {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        queue.push({ node: node.childNodes[i], depth: depth + 1 });
                    }
                }
            }
        }
        return null;
    }

    /**
     * 从 React 挂载元素取出根 Fiber。
     *
     * 两条版本路径：
     *   - React 18+：容器上的 `__reactContainer$xxx` 直接就是（或关联）根 Fiber
     *   - React ≤17：`_reactRootContainer._internalRoot.current` 是当前根 Fiber
     *
     * @param element - React 挂载元素
     * @returns 根 Fiber；取不到时为 null
     */
    function getReactRootFiber(element: ReactElementLike): ReactFiberLike | null {
        try {
            const containerKey = findKeyByPrefix(element, '__reactContainer');
            if (containerKey) {
                const container = element[containerKey] as ReactFiberLike | null;
                if (container) {
                    // __reactContainer 可能指向 HostRoot fiber，也可能需要经 current 下钻
                    return container.current || container;
                }
            }

            const legacyRoot = element._reactRootContainer;
            if (legacyRoot) {
                const internalRoot = (legacyRoot as { _internalRoot?: { current?: ReactFiberLike } })._internalRoot;
                if (internalRoot?.current) {
                    return internalRoot.current;
                }
                // 旧结构里 _reactRootContainer 本身可能带 current
                return (legacyRoot as { current?: ReactFiberLike }).current || null;
            }

            // 兜底：任意 __reactFiber$ 引用，沿 return 上溯到根
            const fiberKey = findKeyByPrefix(element, '__reactFiber');
            if (fiberKey) {
                let fiber = element[fiberKey] as ReactFiberLike | null;
                while (fiber && fiber.return) {
                    fiber = fiber.return;
                }
                return fiber;
            }
        } catch (e) {
            handleError(e, 'getReactRootFiber');
        }
        return null;
    }

    /**
     * 推断 React 版本号。
     *
     * 按可信度依次尝试：
     *   1. 全局 window.React.version（UMD/全局构建才有）
     *   2. React DevTools 钩子 renderers 上携带的 version 字段
     *   3. 依据挂载标记做「大版本级别」的启发式判断：
     *      - 存在 `__reactContainer` → 标记为 Concurrent(18+)
     *      - 存在 `_reactRootContainer` → 标记为 Legacy(≤17)
     *
     * React 默认打包不会把版本暴露到 window，因此第 3 步是常见落点；
     * 拿不到精确版本时返回可辨识的启发式标签，而非直接 'unknown'。
     *
     * @param element - React 挂载元素
     * @returns 版本号字符串或启发式标签
     */
    function getReactVersion(element: ReactElementLike): string {
        try {
            if (window.React && window.React.version) {
                return window.React.version;
            }

            const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
            const renderers = hook?.renderers as Record<string, { version?: string }> | undefined;
            if (renderers) {
                const keys = Object.keys(renderers);
                for (let i = keys.length - 1; i >= 0; i--) {
                    const version = renderers[keys[i]]?.version;
                    if (version) {
                        return version;
                    }
                }
            }
        } catch (e) {
            handleError(e, 'getReactVersion');
        }

        // 启发式：按挂载标记给出大版本范围标签
        if (findKeyByPrefix(element, '__reactContainer')) {
            return '18+ (Concurrent)';
        }
        if (element._reactRootContainer) {
            return '≤17 (Legacy)';
        }
        return 'unknown';
    }

    /**
     * 判断一个对象是否「像一个 React Router data router 实例」。
     *
     * v6.4+ 的 create*Router 返回对象同时具备：
     *   - routes：路由配置数组（原始定义）
     *   - navigate：编程式跳转方法
     *   - state：含 matches / navigation 的运行时状态
     * 三者同时命中即认定，误判概率极低。
     *
     * @param candidate - 待判定的未知对象
     * @returns 是否为 data router 实例
     */
    function isReactRouterLike(candidate: unknown): candidate is ReactRouterLike {
        if (!candidate || typeof candidate !== 'object') {
            return false;
        }
        const obj = candidate as ReactRouterLike;
        return Array.isArray(obj.routes) &&
            typeof obj.navigate === 'function' &&
            !!(obj.state && typeof obj.state === 'object');
    }

    /**
     * 遍历 Fiber 树，尝试挖出 React Router 实例。
     *
     * data router 实例会作为某个组件的 props / state / context value 存在于
     * Fiber 节点上，因此对每个节点检查以下位置：
     *   - stateNode（类实例）
     *   - memoizedProps（含 RouterProvider 的 router 属性）
     *   - memoizedState（Hook 链表，逐项检查其 memoizedState 值）
     *
     * 为避免超深页面卡住，设 6000 节点上限；用 visited 集合切断循环引用。
     *
     * @param rootFiber - 根 Fiber
     * @returns 找到的 router 实例；未找到时为 null
     */
    function detectReactRouterObject(rootFiber: ReactFiberLike | null): ReactRouterLike | null {
        if (!rootFiber) {
            return null;
        }

        const queue: ReactFiberLike[] = [rootFiber];
        const visited = new Set<ReactFiberLike>();
        let scanned = 0;

        /** 从若干候选值里判定并取出 router */
        const pickRouter = (...candidates: unknown[]): ReactRouterLike | null => {
            for (const candidate of candidates) {
                if (isReactRouterLike(candidate)) {
                    return candidate;
                }
                // RouterProvider 把 router 放在 props.router 上
                if (candidate && typeof candidate === 'object') {
                    const wrapped = (candidate as { router?: unknown }).router;
                    if (isReactRouterLike(wrapped)) {
                        return wrapped;
                    }
                }
            }
            return null;
        };

        while (queue.length && scanned < 6000) {
            const fiber = queue.shift() as ReactFiberLike;
            if (!fiber || visited.has(fiber)) continue;
            visited.add(fiber);
            scanned += 1;

            // 常见挂载点：props.router / 节点本身 / stateNode
            const found = pickRouter(
                fiber.memoizedProps,
                (fiber.memoizedProps as { router?: unknown } | undefined)?.router,
                fiber.stateNode
            );
            if (found) {
                return found;
            }

            // 遍历 Hook 链表（函数组件的 useState/useContext 值都挂在这里）
            let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
            let guard = 0;
            while (hook && guard < 100) {
                const viaHook = pickRouter(hook.memoizedState);
                if (viaHook) {
                    return viaHook;
                }
                hook = hook.next as typeof hook;
                guard += 1;
            }

            if (fiber.child) queue.push(fiber.child);
            if (fiber.sibling) queue.push(fiber.sibling);
        }

        return null;
    }

    /**
     * 递归展开 data router 的 routes 配置为完整路径清单。
     *
     * React Router v6.4+ 的子路由 path 是**相对**的（无前导斜杠，可能缺省），
     * 需要与父路径拼接；index 路由与 path 缺省的 layout 路由沿用父路径。
     * 参数段（:id）原样保留，与 Vue 枚举行为保持一致。
     *
     * @param routes - 路由配置数组
     * @param basePath - 父级已拼接好的绝对路径
     * @param out - 结果累加容器
     */
    function flattenReactRoutes(
        routes: ReactRouteConfigLike[] | undefined,
        basePath: string,
        out: RouteEntry[]
    ): void {
        if (!Array.isArray(routes)) return;

        routes.forEach(route => {
            if (!route || typeof route !== 'object') return;

            const rawPath = typeof route.path === 'string' ? route.path : '';
            let fullPath: string;

            if (!rawPath || route.index) {
                // index 路由或无 path 的布局路由：沿用父路径
                fullPath = basePath || '/';
            } else if (rawPath.startsWith('/')) {
                // 绝对路径（极少见于 children）：直接使用
                fullPath = rawPath;
            } else {
                // 相对路径：与父路径拼接
                const parent = basePath === '/' ? '' : basePath;
                fullPath = `${parent}/${rawPath}`;
            }

            // 归一化：确保以 / 开头、去掉重复斜杠
            if (!fullPath.startsWith('/')) {
                fullPath = '/' + fullPath;
            }
            fullPath = fullPath.replace(/\/\/+/g, '/');

            out.push({
                name: typeof route.id === 'string' ? route.id : undefined,
                path: fullPath,
                meta: (route as { handle?: Record<string, any> }).handle ? (route.handle as Record<string, any>) : {}
            });

            const children = route.children || route.routes;
            if (Array.isArray(children) && children.length) {
                flattenReactRoutes(children, fullPath, out);
            }
        });
    }

    /**
     * 从运行时状态尽力收集 React 路由路径（data router 枚举失败时的兜底）。
     *
     * 覆盖两个来源：
     *   1. router.state.matches —— 当前匹配链上的 pathname（至少拿到已激活路径）
     *   2. window.__REACT_ROUTER_DATA__ —— v6.4+ SSR/prefetch 注入的路由数据
     *
     * @param router - 已发现的 router（可为 null）
     * @returns 收集到的路由条目
     */
    function collectReactRoutesFromRuntime(router: ReactRouterLike | null): RouteEntry[] {
        const list: RouteEntry[] = [];

        try {
            if (router && Array.isArray(router.state?.matches)) {
                router.state!.matches.forEach(match => {
                    if (match && typeof match.pathname === 'string') {
                        list.push({ name: match.routeId, path: match.pathname, meta: {} });
                    }
                });
            }
        } catch (e) {
            handleError(e, 'collectReactRoutesFromRuntime:matches');
        }

        return list;
    }

    /**
     * 执行完整的 React / React Router 分析。
     *
     * 与 performFullAnalysis（Vue）保持同样的结果结构，仅 framework 字段不同：
     *   1. 取出根 Fiber，读版本
     *   2. 从 Fiber 树发现 data router，成功则展开 routes 配置树
     *   3. 发现失败则退化为运行时状态收集（routerDetected 相应置否）
     *   4. 复用页面链接前缀分析推测候选基础路径
     *
     * React 没有集中的守卫/meta，本函数只做**只读枚举**；
     * 鉴权绕过统一交由 all-in.js 前置接管。
     *
     * @param element - React 挂载元素
     * @returns 分析结果
     */
    function performReactAnalysis(element: ReactElementLike): RouterAnalysisResult {
        const result: RouterAnalysisResult & {
            framework: FrameworkKind;
            reactVersion: string | null;
            allRoutes: RouteEntry[];
        } = {
            vueDetected: false,
            routerDetected: false,
            framework: 'react',
            vueVersion: null,
            reactVersion: null,
            modifiedRoutes: [],
            allRoutes: [],
            routerBase: '',
            pageAnalysis: {
                detectedBasePath: '',
                commonPrefixes: []
            },
            currentPath: window.location.pathname
        };

        try {
            const rootFiber = getReactRootFiber(element);
            result.reactVersion = getReactVersion(element);
            console.log('✅ React 版本：', result.reactVersion);

            const router = detectReactRouterObject(rootFiber);

            if (router) {
                result.routerDetected = true;
                flattenReactRoutes(router.routes, '', result.allRoutes);

                // 运行时状态兜底：把 matches 里的当前路径也纳入（去重交给 popup）
                if (!result.allRoutes.length) {
                    result.allRoutes = collectReactRoutesFromRuntime(router);
                }
                console.log('🔍 React Router data router 已定位，路由数：', result.allRoutes.length);
            } else {
                result.allRoutes = collectReactRoutesFromRuntime(null);
                console.warn('🚫 未定位到可枚举的 React Router 实例（可能是声明式 <Routes> 或是版本无法静态枚举）');
            }

            // 复用页面链接分析，得到候选基础路径
            result.pageAnalysis = analyzePageLinks();
            if (result.pageAnalysis.detectedBasePath) {
                console.log('🔍 从页面链接检测到基础路径:', result.pageAnalysis.detectedBasePath);
            }

            return result;
        } catch (error) {
            handleError(error, 'performReactAnalysis', true);
            return {
                vueDetected: false,
                routerDetected: false,
                framework: 'react',
                error: String(error)
            };
        }
    }

    // ======== 统一框架检测入口 ========

    /**
     * 统一探测页面框架：先 Vue，后 React。
     *
     * 顺序考量：Vue 的根实例集中在挂载点、探测成本低；
     * React 需要扫描 DOM 找 Fiber 标记、成本相对高，因此作为次选。
     * 微前端等同时存在两者的场景下，优先返回 Vue（与既有行为兼容）。
     *
     * @returns 命中的框架及对应元素；均未命中时为 null
     */
    function detectFramework(): { framework: FrameworkKind; vueRoot?: VueElementLike; reactRoot?: ReactElementLike } | null {
        const vueRoot = findVueRoot(document.body);
        if (vueRoot) {
            return { framework: 'vue', vueRoot };
        }

        const reactRoot = findReactRoot(document.body);
        if (reactRoot) {
            return { framework: 'react', reactRoot };
        }

        return null;
    }

    // ======== 延迟检测机制 ========

    /**
     * 依据命中的框架执行分析并回传：先报检测结果，再延迟 50ms 报完整分析。
     *
     * 抽出为函数，是为了让「立即检测」和「延迟检测重试」两条路径复用同一套逻辑，
     * 保持消息时序一致（popup 依赖这个时序把状态从 loading 推进到 ready）。
     *
     * @param hit - detectFramework 的命中结果
     * @param methodLabel - 检测方式描述，随检测结果一并上报
     */
    function analyzeAndReport(
        hit: { framework: FrameworkKind; vueRoot?: VueElementLike; reactRoot?: ReactElementLike },
        methodLabel: string
    ): void {
        sendResult({
            detected: true,
            method: methodLabel,
            framework: hit.framework
        });

        setTimeout(() => {
            const analysisResult = hit.framework === 'vue'
                ? performFullAnalysis()
                : performReactAnalysis(hit.reactRoot as ReactElementLike);
            sendRouterResult(analysisResult);
        }, 50);
    }

    /**
     * 延迟检测机制：应对框架实例延迟挂载的场景。
     *
     * 部分页面的 Vue / React 应用在首屏后才初始化（如等待接口返回、异步路由），
     * 立即检测会误判为「未使用框架」，因此按 0ms -> 300ms -> 600ms
     * 三级延迟重试，最多 3 次。
     *
     * 一旦探测到框架实例，便与立即检测路径保持一致：
     * 先上报检测结果，再延迟 50ms 执行完整分析并回传。
     *
     * @param delay - 本次延迟毫秒数
     * @param retryCount - 已重试次数，达到 3 次即放弃
     */
    function delayedDetection(delay: number = 0, retryCount: number = 0): void {
        // 改为最大重试3次
        if (retryCount >= 3) {
            sendResult({
                detected: false,
                method: 'Max retry limit reached (3 attempts)'
            });
            return;
        }

        setTimeout(() => {
            const hit = detectFramework();

            if (hit) {
                // 延迟挂载场景下找到实例：与立即检测路径保持一致
                analyzeAndReport(hit, `Delayed detection (${delay}ms)`);
            } else if (delay === 0) {
                delayedDetection(300, retryCount + 1);    // 第1次重试：300ms
            } else if (delay === 300) {
                delayedDetection(600, retryCount + 1);    // 第2次重试：600ms
            } else {
                sendResult({
                    detected: false,
                    method: `All delayed detection failed (${retryCount + 1} attempts)`
                });
            }
        }, delay);
    }

    // ======== 主执行逻辑 ========
    // 脚本注入后立即尝试检测：
    //   - 命中框架实例（Vue 或 React）：先上报检测结果，再延迟 50ms 执行完整分析
    //     （留出时间让框架完成内部初始化，避免读取到不完整的路由表）
    //   - 未命中：转入延迟检测流程，按 0/300/600ms 重试
    //   - 抛出异常：记录后直接以 500ms 延迟重试
    try {
        const hit = detectFramework();

        if (hit) {
            analyzeAndReport(hit, 'Immediate detection');
        } else {
            delayedDetection(0, 0); // 添加初始重试计数
        }
    } catch (error) {
        handleError(error, 'Main execution', false);
        delayedDetection(500, 0); // 添加初始重试计数
    }
})();
