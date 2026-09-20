/**
 * King-CrackX —— 梭哈模式（MAIN world，document_start 前置注入）
 *
 * 目标：在目标页面加载业务代码之前抢跑，强制接管 Vue Router，
 * 使前端路由守卫与鉴权跳转全部失效，从而直接访问受保护的路由。
 *
 * 拦截三个层面：
 *   1. 守卫注册层 —— 拦截 beforeEach/beforeResolve/afterEach，
 *      并 hook Array.prototype.push 阻断守卫被塞进内部容器
 *   2. 存量守卫层 —— 清空各版本 Router 内部的守卫容器
 *   3. 跳转层     —— 拦截 router.push/replace/go、history.*、
 *      location.assign/replace 与 window.close，防止被踢回登录页
 *
 * 由 background.js 按站点白名单动态注册，仅对用户开启过的站点生效。
 */
(function() {
    const INSTALL_KEY = '__VUECRACK_ALL_IN_INSTALLED__';
    const STATE_KEY = '__VUECRACK_ALL_IN_STATE__';

    // 重入保护：同一页面（含 iframe）可能被注入多次，只允许执行一次
    if (window[INSTALL_KEY]) {
        return;
    }

    try {
        // 用不可配置、不可写的属性打标记，防止页面侧覆盖后重复注入
        Object.defineProperty(window, INSTALL_KEY, {
            value: true,
            configurable: false,
            writable: false
        });
    } catch (error) {
        return;
    }

    // 已接管的 Router 实例，避免对同一实例重复 patch
    const patchedRouters = new WeakSet();
    // 已改写的原型对象（如 VueRouter.prototype），确保只改写一次
    const patchedObjects = new WeakSet();
    // 保存原始 push，供 hook 后透传调用
    const originalArrayPush = Array.prototype.push;
    // 保存原始 history 方法（当前实现未回退使用，保留以备恢复）
    const originalHistory = {
        back: history.back,
        forward: history.forward,
        go: history.go
    };

    // 拦截统计状态，实时上报给 popup 展示
    const state = {
        injected: true,
        injectedAt: Date.now(),
        routersPatched: 0,
        guardRegistrationBlocked: 0,
        routerJumpBlocked: 0,
        browserJumpBlocked: 0,
        lastEvent: '已前置注入'
    };

    // 挂到 window 上，便于在页面控制台调试查看
    window[STATE_KEY] = state;

    /**
     * 构造当前拦截状态的快照对象。
     * 只输出必要字段，不直接暴露内部 state 引用，避免外部误改。
     *
     * @returns {Object} 状态快照，供 popup 展示拦截统计
     */
    function getStatus() {
        return {
            injected: state.injected,
            injectedAt: state.injectedAt,
            routersPatched: state.routersPatched,
            guardRegistrationBlocked: state.guardRegistrationBlocked,
            routerJumpBlocked: state.routerJumpBlocked,
            browserJumpBlocked: state.browserJumpBlocked,
            lastEvent: state.lastEvent
        };
    }

    /**
     * 通过 window.postMessage 向 content.js 上报当前状态。
     * 发送失败（页面消息通道异常）时静默忽略，不影响拦截主逻辑。
     */
    function emitStatus() {
        try {
            window.postMessage({
                type: 'VUECRACK_ALL_IN_STATUS',
                source: 'vuecrack-all-in',
                status: getStatus()
            }, '*');
        } catch (error) {
            // 页面消息不可用时不影响拦截逻辑。
        }
    }

    /**
     * 记录最近一次拦截事件并立即上报状态。
     * @param {string} eventName - 事件描述，如"已拦截 beforeEach"
     */
    function mark(eventName) {
        state.lastEvent = eventName;
        emitStatus();
    }

    /**
     * 安全地给对象设置属性值。
     *
     * 优先使用 Object.defineProperty（可覆盖某些只读属性），
     * 失败则退化为直接赋值，再失败返回 false。
     * 用于替换 router 上的方法而不破坏页面原有属性描述符。
     *
     * @param {Object} target - 目标对象
     * @param {string} key - 属性名
     * @param {*} value - 要设置的值
     * @returns {boolean} 是否设置成功
     */
    function defineValue(target, key, value) {
        try {
            Object.defineProperty(target, key, {
                value,
                configurable: true,
                writable: true
            });
            return true;
        } catch (error) {
            try {
                target[key] = value;
                return true;
            } catch (innerError) {
                return false;
            }
        }
    }

    /**
     * 把被替换的函数伪装成原生函数。
     *
     * 重写 fn.toString() 使其返回 "function xxx() { [native code] }"，
     * 降低被页面反调试逻辑识别的风险。伪装失败不影响主流程。
     *
     * @param {Function} fn - 替换后的替身函数
     * @param {string} name - 伪装显示的函数名
     */
    function maskToString(fn, name) {
        try {
            defineValue(fn, 'toString', function() {
                return `function ${name}() { [native code] }`;
            });
        } catch (error) {
            // 伪装失败不影响主流程。
        }
    }

    /**
     * 生成"守卫注册拦截器"。
     *
     * 用途：替换 router.beforeEach / beforeResolve / afterEach。
     * 页面再调用这些方法注册守卫时会被静默吞掉（仅计数），
     * 并返回一个空的移除函数以保持 API 形态兼容，避免调用方报错。
     *
     * @param {string} name - 被替换的钩子名，用于统计与日志
     * @returns {Function} 拦截器函数
     */
    function makeGuardBlocker(name) {
        const blocker = function() {
            state.guardRegistrationBlocked += 1;
            mark(`已拦截 ${name}`);
            return function removeBlockedGuard() {};
        };
        maskToString(blocker, name);
        return blocker;
    }

    /**
     * 生成"Router 跳转拦截器"。
     *
     * 用途：替换 router.push / replace / go，阻止页面把用户踢回登录页。
     * push/replace 的调用契约要求返回 Promise，故返回
     * Promise.resolve(false) 表示"跳转被拒绝"。
     *
     * @param {string} name - 被替换的方法名
     * @returns {Function} 拦截器函数
     */
    function makeRouterJumpBlocker(name) {
        const blocker = function() {
            state.routerJumpBlocked += 1;
            mark(`已拦截 router.${name}`);
            if (name === 'push' || name === 'replace') {
                return Promise.resolve(false);
            }
            return undefined;
        };
        maskToString(blocker, name);
        return blocker;
    }

    /**
     * 生成"浏览器跳转拦截器"。
     *
     * 用途：替换 history.back/forward/go、location.assign/replace、window.close，
     * 阻止页面用原生方式强制离开当前页。
     *
     * @param {string} name - 被替换的方法全名，如 'history.back'
     * @returns {Function} 拦截器函数
     */
    function makeBrowserJumpBlocker(name) {
        const blocker = function() {
            state.browserJumpBlocked += 1;
            mark(`已拦截 ${name}`);
            return undefined;
        };
        // 伪装时只取方法名部分（'history.back' -> 'back'）
        maskToString(blocker, name.split('.').pop());
        return blocker;
    }

    /**
     * 判断某个 meta 字段值是否表示"需要鉴权"。
     * 兼容布尔、字符串、数字三种写法。
     *
     * @param {*} value - meta 字段值
     * @returns {boolean} true 表示该字段要求鉴权
     */
    function isAuthTrue(value) {
        return value === true || value === 'true' || value === 1 || value === '1';
    }

    /**
     * 递归改写单个路由及其子路由的鉴权 meta 字段。
     *
     * 把 key 中含 auth / login / permission 且值为真的字段改为 false，
     * 使前端路由级别的鉴权判断失效。递归处理 children 以覆盖嵌套路由。
     *
     * @param {Object} route - 路由对象
     */
    function patchRouteMeta(route) {
        if (!route || typeof route !== 'object') {
            return;
        }

        if (route.meta && typeof route.meta === 'object') {
            Object.keys(route.meta).forEach(key => {
                const lowerKey = key.toLowerCase();
                if ((lowerKey.includes('auth') || lowerKey.includes('login') || lowerKey.includes('permission')) && isAuthTrue(route.meta[key])) {
                    route.meta[key] = false;
                }
            });
        }

        if (Array.isArray(route.children)) {
            route.children.forEach(patchRouteMeta);
        }
    }

    /**
     * 遍历 router 上所有可获取的路由表，逐一改写鉴权 meta。
     *
     * 依次尝试三种来源（覆盖不同版本实现），命中即处理：
     *   - getRoutes()          ：Vue Router 4
     *   - options.routes       ：Vue Router 2/3 的原始配置
     *   - matcher.getRoutes()  ：内部匹配器中的路由记录
     *
     * @param {Object} router - Vue Router 实例
     */
    function patchRoutes(router) {
        try {
            if (typeof router.getRoutes === 'function') {
                router.getRoutes().forEach(patchRouteMeta);
            }

            if (Array.isArray(router.options?.routes)) {
                router.options.routes.forEach(patchRouteMeta);
            }

            if (Array.isArray(router.matcher?.getRoutes?.())) {
                router.matcher.getRoutes().forEach(patchRouteMeta);
            }
        } catch (error) {
            // 路由元信息失败不影响其他强拦截。
        }
    }

    /**
     * 清空一个"守卫容器"。
     *
     * 不同版本 Router 的内部守卫可能存放在数组、Set、Map，
     * 或带 list 数组 / reset 方法的自定义容器中，此处逐一适配。
     *
     * @param {*} value - 待清空的容器
     * @returns {boolean} 是否成功清空
     */
    function clearGuardContainer(value) {
        try {
            if (Array.isArray(value)) {
                value.length = 0;
                return true;
            }

            if (value instanceof Set || value instanceof Map) {
                value.clear();
                return true;
            }

            if (value && typeof value === 'object') {
                if (Array.isArray(value.list)) {
                    value.list.length = 0;
                    return true;
                }
                if (typeof value.reset === 'function') {
                    value.reset();
                    return true;
                }
            }
        } catch (error) {
            return false;
        }

        return false;
    }

    /**
     * 清空 router 上所有已知的守卫容器属性。
     * 属性名清单覆盖 Vue Router 2/3/4 各版本的内部实现差异。
     *
     * @param {Object} router - Vue Router 实例
     */
    function clearKnownGuardContainers(router) {
        [
            'beforeGuards',
            'beforeResolveGuards',
            'afterGuards',
            'beforeHooks',
            'resolveHooks',
            'afterHooks',
            'beforeEachHooks',
            'beforeResolveHooks',
            'afterEachHooks'
        ].forEach(key => clearGuardContainer(router[key]));
    }

    /**
     * 接管一个 Router 实例（核心入口）。
     *
     * 完整流程：
     *   1. 用 patchedRouters 去重，避免重复接管同一实例
     *   2. 替换 beforeEach / beforeResolve / afterEach 为守卫拦截器
     *   3. 替换 push / replace / go 为跳转拦截器
     *   4. 清空已注册的守卫容器（清掉接管前就已存在的守卫）
     *   5. 改写路由 meta 中的鉴权字段
     *
     * 顺序敏感：必须先替换钩子方法再清空容器，
     * 否则页面后续仍可能通过原方法重新注册守卫。
     *
     * @param {Object} router - Vue Router 实例
     * @returns {boolean} true 表示本次成功接管；false 表示无效或已接管过
     */
    function patchRouter(router) {
        if (!router || typeof router !== 'object' || patchedRouters.has(router)) {
            return false;
        }

        patchedRouters.add(router);

        ['beforeEach', 'beforeResolve', 'afterEach'].forEach(name => {
            if (typeof router[name] === 'function') {
                defineValue(router, name, makeGuardBlocker(name));
            }
        });

        ['push', 'replace', 'go'].forEach(name => {
            if (typeof router[name] === 'function') {
                defineValue(router, name, makeRouterJumpBlocker(name));
            }
        });

        clearKnownGuardContainers(router);
        patchRoutes(router);

        state.routersPatched += 1;
        mark('已接管 Router');
        return true;
    }

    /**
     * 在原型层面接管 Vue Router（覆盖"尚未创建的实例"）。
     *
     * 为什么需要：逐实例接管只能处理已存在的 Router，
     * 若页面上存在全局 VueRouter 构造函数（UMD 构建），
     * 在此处 patch 原型可以抢先覆盖后续 new 出来的所有实例，
     * 相当于把拦截提前到"实例诞生之前"。
     *
     * 用 patchedObjects 保证原型只被改写一次。
     */
    function patchVueRouterPrototype() {
        try {
            const proto = window.VueRouter?.prototype;
            if (!proto || patchedObjects.has(proto)) {
                return;
            }

            patchedObjects.add(proto);

            ['beforeEach', 'beforeResolve', 'afterEach'].forEach(name => {
                if (typeof proto[name] === 'function') {
                    defineValue(proto, name, makeGuardBlocker(name));
                }
            });

            ['push', 'replace', 'go'].forEach(name => {
                if (typeof proto[name] === 'function') {
                    defineValue(proto, name, makeRouterJumpBlocker(name));
                }
            });
        } catch (error) {
            // VueRouter 全局对象不存在时跳过。
        }
    }

    /**
     * 从 DOM 元素上探测并取出 Vue Router 实例。
     *
     * 两条兼容路径：
     *   - element.__vue_app__ ：Vue 3 应用实例，从 app.config.globalProperties
     *     或 _instance 上下文链上取 $router
     *   - element.__vue__     ：Vue 2 组件实例，从 $router / $root / _router 取
     *
     * 全程 try/catch：探测过程会触碰页面对象的内部属性，
     * 某些实现可能抛出异常，此处需容错返回 null。
     *
     * @param {Element} element - 待探测的 DOM 元素
     * @returns {Object|null} Vue Router 实例；未找到时为 null
     */
    function findVueRouterFromElement(element) {
        try {
            if (element.__vue_app__) {
                const app = element.__vue_app__;
                return app.config?.globalProperties?.$router ||
                    app._instance?.appContext?.config?.globalProperties?.$router ||
                    app._instance?.ctx?.$router ||
                    null;
            }

            if (element.__vue__) {
                const vue = element.__vue__;
                return vue.$router ||
                    vue.$root?.$router ||
                    vue.$root?.$options?.router ||
                    vue._router ||
                    null;
            }
        } catch (error) {
            return null;
        }

        return null;
    }

    /**
     * 扫描整个 DOM 树，找出所有 Vue Router 实例并逐一接管。
     *
     * 实现要点：
     *   - 广度优先遍历（队列），先在浅层命中能更快完成接管
     *   - 用 visited 集合防止重复访问（Vue 会在元素上挂引用，可能形成环）
     *   - 上限 8000 个节点，避免超大页面导致长时间占用主线程
     *   - 每次扫描都顺带尝试 patch 原型，覆盖动态创建的实例
     */
    function scanRouters() {
        patchVueRouterPrototype();

        if (!document.documentElement) {
            return;
        }

        const queue = [document.documentElement];
        const visited = new Set();
        let scanned = 0;

        // 广度优先遍历，带节点数上限保护
        while (queue.length && scanned < 8000) {
            const node = queue.shift();
            scanned += 1;

            if (!node || visited.has(node)) {
                continue;
            }
            visited.add(node);

            // 只探测元素节点（nodeType 1）
            if (node.nodeType === 1) {
                const router = findVueRouterFromElement(node);
                if (router) {
                    patchRouter(router);
                }

                if (node.childNodes && node.childNodes.length) {
                    for (let i = 0; i < node.childNodes.length; i++) {
                        queue.push(node.childNodes[i]);
                    }
                }
            }
        }
    }

    /**
     * 安装 Array.prototype.push 钩子，阻断「守卫被注册进内部数组」。
     *
     * 背景：部分 Vue Router 版本把守卫统一推入内部数组管理，
     * 即便钩子方法已被替换，某些代码路径仍可能直接操作数组。
     *
     * 判定方式：通过调用栈判断本次 push 是否发生在
     * beforeEach / beforeResolve / afterEach 的执行上下文内，
     * 且被推入的是函数（守卫必然是函数），两者同时成立才拦截。
     *
     * 安全性：栈信息读取失败时一律放行，避免误伤页面正常数组操作。
     */
    function installArrayPushGuardBlocker() {
        const hookedPush = function() {
            // 只关心"推入函数"的场景，普通数据 push 直接放行
            if (arguments.length > 0 && typeof arguments[0] === 'function') {
                try {
                    const stack = new Error().stack || '';
                    if (
                        stack.includes('beforeEach') ||
                        stack.includes('beforeResolve') ||
                        stack.includes('afterEach')
                    ) {
                        state.guardRegistrationBlocked += 1;
                        mark('已阻止守卫注册');
                        return originalArrayPush.call(this);
                    }
                } catch (error) {
                    // stack 读取失败时放行，避免破坏普通数组。
                }
            }

            // 正常路径：调用原始 push 保持行为不变
            return originalArrayPush.apply(this, arguments);
        };

        maskToString(hookedPush, 'push');
        defineValue(Array.prototype, 'push', hookedPush);
    }

    /**
     * 安装浏览器层面的跳转拦截器。
     *
     * 覆盖范围：
     *   - history.back / forward / go      ：浏览器前进后退
     *   - location.assign / replace        ：地址跳转（改原型以覆盖所有实例）
     *   - window.close                     ：关闭当前窗口
     *
     * Location 原型的改写需要 try/catch —— 部分页面通过属性描述符
     * 保护了 Location，强行改写会抛异常，此时跳过即可。
     */
    function installBrowserJumpBlockers() {
        if (typeof history.back === 'function') {
            defineValue(history, 'back', makeBrowserJumpBlocker('history.back'));
        }
        if (typeof history.forward === 'function') {
            defineValue(history, 'forward', makeBrowserJumpBlocker('history.forward'));
        }
        if (typeof history.go === 'function') {
            defineValue(history, 'go', makeBrowserJumpBlocker('history.go'));
        }

        try {
            const locationPrototype = Location.prototype;
            if (typeof locationPrototype.assign === 'function') {
                defineValue(locationPrototype, 'assign', makeBrowserJumpBlocker('location.assign'));
            }
            if (typeof locationPrototype.replace === 'function') {
                defineValue(locationPrototype, 'replace', makeBrowserJumpBlocker('location.replace'));
            }
        } catch (error) {
            // 某些页面不允许改 Location 原型。
        }

        if (typeof window.close === 'function') {
            defineValue(window, 'close', makeBrowserJumpBlocker('window.close'));
        }
    }

    // 防抖定时器句柄，保证同一时刻只有一个待执行的扫描任务
    let scanTimer = null;

    /**
     * 延迟调度一次路由扫描（带去重保护）。
     *
     * DOM 频繁变动时若每次都立即扫描会严重卡顿，
     * 因此已存在待执行任务时直接忽略新请求（合并为一次扫描）。
     *
     * @param {number} delay - 延迟毫秒数
     */
    function scheduleScan(delay) {
        if (scanTimer) {
            return;
        }

        scanTimer = setTimeout(() => {
            scanTimer = null;
            scanRouters();
        }, delay);
    }

    /**
     * 启动 DOM 变更监听，持续发现并接管"后创建"的 Router。
     *
     * SPA 常按需加载路由或延迟挂载组件，一次性扫描无法覆盖，
     * 因此监听整棵文档树的节点增删，变动后延迟触发扫描。
     */
    function startObserver() {
        if (!document.documentElement || typeof MutationObserver !== 'function') {
            return;
        }

        const observer = new MutationObserver(() => {
            scheduleScan(80);
        });

        // 监听整棵子树的新增节点
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ===== 响应 popup 的状态查询请求 =====
    // content.js 转发 popup 的查询意图，此处回传当前拦截统计。
    // 只处理来自当前页面主世界且带 data 的消息，避免干扰其他消息。
    window.addEventListener('message', event => {
        if (event.source !== window || !event.data) {
            return;
        }

        if (event.data.type === 'VUECRACK_GET_ALL_IN_STATUS') {
            emitStatus();
        }
    });

    // ===== 初始化：立即执行不依赖 DOM 的拦截 =====
    // 这三步必须尽早完成，且不依赖 DOM 就绪：
    //   - push 钩子和浏览器跳转拦截越早安装越难被绕过
    //   - 先上报一次状态，让 popup 知道脚本已注入
    installArrayPushGuardBlocker();
    installBrowserJumpBlockers();
    emitStatus();

    // ===== 首次扫描 + 启动监听 =====
    // document.readyState 为 loading 时等 DOM 解析完成再扫描，
    // 否则（脚本注入较晚）立即执行。
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            scanRouters();
            startObserver();
        });
    } else {
        scanRouters();
        startObserver();
    }

    // ===== 兜底：多个时间点重复扫描 =====
    // 应对不同节奏的框架挂载时机（Vue 可能在任意时刻完成初始化），
    // 用递增间隔多次重试，最终由 MutationObserver 持续接管。
    [50, 150, 350, 800, 1500, 3000, 6000].forEach(delay => {
        setTimeout(scanRouters, delay);
    });
})();
