/**
 * King-CrackX —— Vue 检测与路由分析器（MAIN world）
 *
 * 由 content.js 按需注入到页面主世界，用于：
 *   1. 检测页面是否使用 Vue，并识别版本（Vue 2 / 3）
 *   2. 定位 Vue Router 实例，枚举全部路由（含嵌套子路由）
 *   3. 清除路由守卫、改写鉴权 meta，实现前端路由绕过
 *   4. 分析页面链接，推测 Router 基础路径
 *
 * 结果通过 window.postMessage 回传给 content.js 中转。
 */
(function() {
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
     * @param {Node} root - 遍历起点，通常为 document.body
     * @param {number} [maxDepth=1000] - 最大遍历深度
     * @returns {Node|null} Vue 根节点；未找到时为 null
     */
    function findVueRoot(root, maxDepth = 1000) {
        const queue = [{ node: root, depth: 0 }];
        while (queue.length) {
            const { node, depth } = queue.shift();
            if (depth > maxDepth) break;

            if (node.__vue_app__ || node.__vue__ || node._vnode) {
                return node;
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
     * @param {Error} error - 捕获到的错误
     * @param {string} context - 出错位置标识，便于定位
     * @param {boolean} [shouldStop=false] - 是否为致命错误。
     *        为 true 时额外向扩展上报错误并返回 false，表示应中止流程。
     * @returns {boolean} true 表示可继续执行；false 表示流程中断
     */
    function handleError(error, context, shouldStop = false) {
        const errorMsg = `${context}: ${error.toString()}`;
        console.warn(errorMsg);

        if (shouldStop) {
            sendError(errorMsg);
            return false;
        }
        return true;
    }

    /**
     * 恢复被 performFullAnalysis 临时接管的控制台方法。
     * 必须成对调用，否则会造成 console 永久被改写。
     *
     * @param {Object} originals - 保存的原始控制台方法集合
     */
    function restoreConsole(originals) {
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
     * @param {string} url - 原始 URL
     * @returns {string} 清理后的 URL
     */
    function cleanUrl(url) {
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
     * @param {Node} vueRoot - Vue 根节点
     * @returns {string} 版本号字符串；无法确定时返回 'unknown'
     */
    function getVueVersion(vueRoot) {
        let version = vueRoot.__vue_app__?.version ||
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
     * 上报 Vue 检测结果。
     * @param {Object} result - 形如 { detected: boolean, method: string }
     */
    function sendResult(result) {
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
     * @param {Object} result - performFullAnalysis 产出的原始结果
     */
    function sendRouterResult(result) {
        try {
            // 预处理 - 确保 allRoutes 是正确格式的数组
            if (result && result.allRoutes) {
                if (!Array.isArray(result.allRoutes)) {
                    // 如果不是数组，转换为数组
                    if (typeof result.allRoutes === 'object') {
                        const routeArray = [];
                        for (const key in result.allRoutes) {
                            if (result.allRoutes.hasOwnProperty(key)) {
                                const route = result.allRoutes[key];
                                if (route && typeof route === 'object') {
                                    routeArray.push({
                                        name: route.name || key,
                                        path: route.path || key,
                                        meta: route.meta || {}
                                    });
                                }
                            }
                        }
                        result.allRoutes = routeArray;
                    } else {
                        result.allRoutes = [];
                    }
                } else {
                    // 确保数组中的每个元素都有正确的结构
                    result.allRoutes = result.allRoutes.map(route => {
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
            } else {
                result.allRoutes = [];
            }

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
                    vueVersion: result?.vueVersion || 'Unknown',
                    modifiedRoutes: result?.modifiedRoutes || [],
                    error: 'Serialization failed',
                    allRoutes: []
                }
            }, '*');
        }
    }

    /**
     * 上报路由分析过程中的错误。
     * @param {string} error - 错误描述文本
     */
    function sendError(error) {
        window.postMessage({
            type: 'VUE_ROUTER_ANALYSIS_ERROR',
            error: error
        }, '*');
    }

    // ======== Vue检测函数 ========

    /**
     * 简单 Vue 检测：从 document.body 起查找 Vue 根节点。
     * 作为延迟检测机制的探测入口，只判断"有没有"，不做完整分析。
     *
     * @returns {Node|null} Vue 根节点；未检测到时为 null
     */
    function simpleVueDetection() {
        const vueRoot = findVueRoot(document.body);
        return vueRoot;
    }

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
     * @param {Node} vueRoot - Vue 根节点
     * @returns {Object|null} Vue Router 实例；未找到时为 null
     */
    function findVueRouter(vueRoot) {
        try {
            if (vueRoot.__vue_app__) {
                // Vue3 + Router4
                const app = vueRoot.__vue_app__;

                if (app.config?.globalProperties?.$router) {
                    return app.config.globalProperties.$router;
                }

                const instance = app._instance;
                if (instance?.appContext?.config?.globalProperties?.$router) {
                    return instance.appContext.config.globalProperties.$router;
                }

                if (instance?.ctx?.$router) {
                    return instance.ctx.$router;
                }
            }

            if (vueRoot.__vue__) {
                // Vue2 + Router2/3
                const vue = vueRoot.__vue__;
                return vue.$router ||
                    vue.$root?.$router ||
                    vue.$root?.$options?.router ||
                    vue._router;
            }
        } catch (e) {
            handleError(e, 'findVueRouter');
        }
        return null;
    }

    /**
     * 递归遍历路由数组及其所有嵌套子路由。
     *
     * @param {Array} routes - 路由数组
     * @param {Function} cb - 对每个路由调用的回调
     */
    function walkRoutes(routes, cb) {
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
     * 判断 meta 字段值是否表示"真"（即需要鉴权）。
     * 兼容布尔、字符串、数字三种书写形式。
     *
     * @param {*} val - meta 字段值
     * @returns {boolean} true 表示该字段要求鉴权
     */
    function isAuthTrue(val) {
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
     * @param {string} base - 父级路径
     * @param {string} path - 子级路径
     * @returns {string} 拼接后的完整路径
     */
    function joinPath(base, path) {
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
     * 该值可信度最高，popup 会用它生成"带基础路径"的 URL。
     *
     * @param {Object} router - Vue Router 实例
     * @returns {string} 基础路径；未配置时为空字符串
     */
    function extractRouterBase(router) {
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

    // 页面链接缓存：避免重复查询 DOM（一次分析中会多次用到）
    const linkCache = new Map();

    /**
     * 获取页面中疑似路由链接的 href 列表（带缓存）。
     *
     * 筛选条件：
     *   - 以 / 开头（站内绝对路径）
     *   - 不以 // 开头（排除协议相对 URL）
     *   - 不含 .（排除带扩展名的静态资源链接）
     *
     * @returns {string[]} 疑似路由路径列表
     */
    function getCachedLinks() {
        const cacheKey = 'page-links';
        if (linkCache.has(cacheKey)) {
            return linkCache.get(cacheKey);
        }

        const links = Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.getAttribute('href'))
            .filter(href =>
                href &&
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
     * @returns {{detectedBasePath: string, commonPrefixes: Array<{prefix: string, count: number}>}}
     *          推测出的基础路径与各前缀的命中统计
     */
    function analyzePageLinks() {
        const result = {
            detectedBasePath: '',
            commonPrefixes: []
        };

        try {
            const links = getCachedLinks();

            // 样本过少时统计无意义，直接返回空结果
            if (links.length < 3) return result;

            // 取每个链接的第一段路径并计数
            const pathSegments = links.map(link => link.split('/').filter(Boolean));
            const firstSegments = {};

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
     * 属于"温和模式"；梭哈模式才是全面接管。
     *
     * 兼容三种路由表来源：getRoutes()（Router4）、options.routes（Router2/3）、
     * matcher（内部匹配器）。
     *
     * @param {Object} router - Vue Router 实例
     * @returns {Array<{path: string, name: string}>} 被修改的路由清单，供 popup 展示
     */
    function patchAllRouteAuth(router) {
        const modified = [];

        /**
         * 改写单条路由的 meta 鉴权字段。
         * @param {Object} route - 路由对象
         */
        function patchMeta(route) {
            if (route.meta && typeof route.meta === 'object') {
                Object.keys(route.meta).forEach(key => {
                    if (key.toLowerCase().includes('auth') && isAuthTrue(route.meta[key])) {
                        route.meta[key] = false;
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
     *   1. 把 beforeEach / beforeResolve / afterEach 替换为空函数，
     *      阻断后续注册
     *   2. 清空已知的守卫容器数组，移除接管前已注册的守卫
     *
     * 与 all-in.js 的强拦截相比，本函数不做原型级接管、
     * 不 hook Array.prototype.push，属于一次性清理。
     *
     * @param {Object} router - Vue Router 实例
     */
    function patchRouterGuards(router) {
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
                if (Array.isArray(router[prop])) {
                    router[prop].length = 0;
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
     * @param {*} obj - 待清洗的数据
     * @returns {*} 可安全 postMessage 的数据
     */
    function sanitizeForPostMessage(obj) {
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
            if (obj.constructor && obj.constructor.name &&
                !['Object', 'Array'].includes(obj.constructor.name)) {
                return `[${obj.constructor.name}]`;
            }

            const sanitized = Array.isArray(obj) ? [] : {};

            try {
                for (const key in obj) {
                    if (obj.hasOwnProperty && obj.hasOwnProperty(key)) {
                        const value = obj[key];

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
     * @param {*} obj - 待清洗的浅层对象
     * @returns {*} 清洗后的对象，值类型只会是原始值或类型标签字符串
     */
    function sanitizeRouteObject(obj) {
        if (!obj || typeof obj !== 'object') {
            return obj;
        }

        const sanitized = {};

        try {
            for (const key in obj) {
                if (obj.hasOwnProperty && obj.hasOwnProperty(key)) {
                    const value = obj[key];

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
     * @param {Object} router - Vue Router 实例
     * @returns {Array<{name: string, path: string, meta: Object}>} 路由清单
     */
    function listAllRoutes(router) {
        const list = [];

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
                 * @param {Array} routes - 路由配置数组
                 * @param {string} [basePath=''] - 父级路径，用于拼接
                 */
                function traverse(routes, basePath = '') {
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
     * @returns {Object} 分析结果，含 vueDetected / routerDetected / vueVersion /
     *                   allRoutes / routerBase / pageAnalysis / modifiedRoutes / logs
     */
    function performFullAnalysis() {
        const result = {
            vueDetected: false,
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
        const originals = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            table: console.table
        };

        try {
            // 拦截控制台输出
            console.log = function(...args) {
                result.logs.push({type: 'log', message: args.join(' ')});
                originals.log.apply(console, args);
            };
            console.warn = function(...args) {
                result.logs.push({type: 'warn', message: args.join(' ')});
                originals.warn.apply(console, args);
            };
            console.error = function(...args) {
                result.logs.push({type: 'error', message: args.join(' ')});
                originals.error.apply(console, args);
            };
            console.table = function(data, columns) {
                if (Array.isArray(data)) {
                    result.logs.push({type: 'table', data: [...data]});
                } else {
                    result.logs.push({type: 'table', data: {...data}});
                }
                originals.table.apply(console, arguments);
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
                error: error.toString()
            };
        }
    }

    // ======== 延迟检测机制 ========

    /**
     * 延迟检测机制：应对 Vue 实例延迟挂载的场景。
     *
     * 部分页面的 Vue 应用在首屏后才初始化（如等待接口返回、异步路由），
     * 立即检测会误判为"未使用 Vue"，因此按 0ms -> 300ms -> 600ms
     * 三级延迟重试，最多 3 次。
     *
     * 一旦探测到 Vue 实例，便与立即检测路径保持一致：
     * 先上报检测结果，再延迟 50ms 执行完整分析并回传。
     *
     * @param {number} [delay=0] - 本次延迟毫秒数
     * @param {number} [retryCount=0] - 已重试次数，达到 3 次即放弃
     */
    function delayedDetection(delay = 0, retryCount = 0) {
        // 改为最大重试3次
        if (retryCount >= 3) {
            sendResult({
                detected: false,
                method: 'Max retry limit reached (3 attempts)'
            });
            return;
        }

        setTimeout(() => {
            const vueRoot = simpleVueDetection();

            if (vueRoot) {
                // 延迟挂载场景下找到Vue实例：与立即检测路径保持一致
                sendResult({
                    detected: true,
                    method: `Delayed detection (${delay}ms)`
                });

                setTimeout(() => {
                    const analysisResult = performFullAnalysis();
                    sendRouterResult(analysisResult);
                }, 50);
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
    //   - 命中 Vue 实例：先上报检测结果，再延迟 50ms 执行完整分析
    //     （留出时间让框架完成内部初始化，避免读取到不完整的路由表）
    //   - 未命中：转入延迟检测流程，按 0/300/600ms 重试
    //   - 抛出异常：记录后直接以 500ms 延迟重试
    try {
        const vueRoot = simpleVueDetection();

        if (vueRoot) {
            sendResult({
                detected: true,
                method: 'Immediate detection'
            });

            setTimeout(() => {
                const analysisResult = performFullAnalysis();
                sendRouterResult(analysisResult);
            }, 50);
        } else {
            delayedDetection(0, 0); // 添加初始重试计数
        }
    } catch (error) {
        handleError(error, 'Main execution', false);
        delayedDetection(500, 0); // 添加初始重试计数
    }
})();