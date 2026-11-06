/**
 * King-CrackX —— detector 拆分：React 框架检测与路由分析
 *
 * 不是独立注入脚本，由 detector.ts 唯一入口 import，最终打包进单个自包含 IIFE `detector.js`。
 * 本模块只负责 React 这一侧：根 Fiber 定位、版本推断，以及按完整度降序尝试的
 * 五类路由来源（Next.js → React Router data → TanStack → 声明式 → 锚点兜底）。
 *
 * React 生态没有集中的守卫/meta，本模块只做**只读枚举**；鉴权绕过统一交由 all-in.js 前置接管。
 *
 * 函数体逐字保留自原 detector.js，仅改为跨模块可见：
 *   - 对外暴露 findReactRoot（入口 detectFramework 需要）与 performReactAnalysis（入口分析分发需要）
 *   - 其余辅助函数在本模块内闭环，保持模块私有
 *   - 错误处理 / 页面链接分析复用 detector-shared
 */

import { analyzePageLinks, handleError } from './detector-shared';

/* ==================== React 根实例与版本 ==================== */

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
export function findReactRoot(root: Node, maxDepth: number = 1000): ReactElementLike | null {
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
                return (container.current as ReactFiberLike | null) || container;
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

/* ==================== React Router 发现与枚举 ==================== */

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
 * 把当前地址栏路径也补进路由清单，保证列表至少有一条可访问的真实 URL。
 *
 * @param out - 结果累加容器
 */
function pushCurrentPath(out: RouteEntry[]): void {
    try {
        const path = window.location.pathname || '/';
        out.push({ name: undefined, path, meta: {} });
    } catch (e) {
        // 地址不可读时跳过
    }
}

/**
 * 收集页面内链（<a href>）作为路由兜底。
 *
 * 用途：当无法定位任何可枚举的路由实例（自研路由 / 特殊配置）时，
 * 至少把页面上出现的站内链接暴露出来，供渗透测试点击与绕路。
 * 过滤掉带扩展名的静态资源链接与外链。
 *
 * @returns 站内链接路径清单
 */
function collectAnchorRoutes(): RouteEntry[] {
    const out: RouteEntry[] = [];
    try {
        const seen = new Set<string>();
        document.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href');
            if (!href || !href.startsWith('/') || href.startsWith('//') || href.includes('.')) {
                return;
            }
            const path = href.split('#')[0].split('?')[0];
            if (!path || seen.has(path)) {
                return;
            }
            seen.add(path);
            out.push({ name: undefined, path, meta: {} });
        });
    } catch (e) {
        handleError(e, 'collectAnchorRoutes');
    }
    return out;
}

/**
 * 判断一个对象是否「像 TanStack Router 实例」。
 *
 * TanStack Router（@tanstack/react-router）的 router 对象特征：
 *   - state：含 location（对象）与 routes（全部路由的扁平表）
 *   - navigate：编程式跳转方法
 *   - options：路由树配置
 * 与 React Router data router 的区分点：TanStack 的 state.location 是对象，
 * 且带 routesById / routesPath 这类扁平索引；React Router 的 state.navigation 才是重点。
 *
 * @param candidate - 待判定的未知对象
 * @returns 是否为 TanStack Router 实例
 */
function isTanStackRouterLike(candidate: unknown): candidate is Record<string, any> {
    if (!candidate || typeof candidate !== 'object') {
        return false;
    }
    const obj = candidate as Record<string, any>;
    return typeof obj.navigate === 'function' &&
        !!(obj.state && typeof obj.state === 'object') &&
        typeof obj.state.location === 'object' &&
        !!(obj.options && typeof obj.options === 'object');
}

/**
 * 遍历 Fiber 树寻找 TanStack Router 实例。
 *
 * 复用与 detectReactRouterObject 相同的遍历骨架（props / hook / stateNode 三处取值），
 * 仅判定函数换成 isTanStackRouterLike。
 *
 * @param rootFiber - 根 Fiber
 * @returns 找到的 router 实例；未找到时为 null
 */
function findTanStackRouter(rootFiber: ReactFiberLike | null): Record<string, any> | null {
    if (!rootFiber) {
        return null;
    }

    const queue: ReactFiberLike[] = [rootFiber];
    const visited = new Set<ReactFiberLike>();
    let scanned = 0;

    const pick = (...candidates: unknown[]): Record<string, any> | null => {
        for (const candidate of candidates) {
            if (isTanStackRouterLike(candidate)) {
                return candidate as Record<string, any>;
            }
            if (candidate && typeof candidate === 'object') {
                const wrapped = (candidate as { router?: unknown }).router;
                if (isTanStackRouterLike(wrapped)) {
                    return wrapped as Record<string, any>;
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

        const found = pick(fiber.memoizedProps, (fiber.memoizedProps as { router?: unknown } | undefined)?.router, fiber.stateNode);
        if (found) return found;

        let hook = fiber.memoizedState as { memoizedState?: unknown; next?: unknown } | null;
        let guard = 0;
        while (hook && guard < 100) {
            const viaHook = pick(hook.memoizedState);
            if (viaHook) return viaHook;
            hook = hook.next as typeof hook;
            guard += 1;
        }

        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
    }

    return null;
}

/**
 * 展开 TanStack Router 的路由为完整路径清单。
 *
 * 优先用 router.state.routes / routesById 这类扁平索引（每项自带 fullPath），
 * 退化时才遍历 options.routes 配置树。
 *
 * @param router - TanStack Router 实例
 * @param out - 结果累加容器
 */
function collectTanStackRoutes(router: Record<string, any>, out: RouteEntry[]): void {
    try {
        const flat: unknown[] = [];

        if (Array.isArray(router.state?.routes)) {
            flat.push(...router.state.routes);
        } else if (router.routesById && typeof router.routesById === 'object') {
            flat.push(...Object.values(router.routesById));
        }

        if (!flat.length && Array.isArray(router.options?.routes)) {
            flat.push(...router.options.routes);
        }

        flat.forEach(node => {
            if (!node || typeof node !== 'object') return;
            const raw = (node as { fullPath?: string; path?: string; id?: string });
            let fullPath = raw.fullPath || raw.path || '';
            if (!fullPath) return;
            if (!fullPath.startsWith('/')) {
                fullPath = '/' + fullPath;
            }
            out.push({ name: raw.id, path: fullPath.replace(/\/\/+/g, '/'), meta: {} });
        });
    } catch (e) {
        handleError(e, 'collectTanStackRoutes');
    }
}

/**
 * 从声明式 React Router（v4/v5 的 <Switch>/<Route>、v6 的 <Routes>/<Route>）中收集路径。
 *
 * 声明式路由没有集中的 routes 数组，但每个 <Route> 都会渲染成一个 Fiber，
 * 其 memoizedProps 上带着 path 以及 element/component/render/children 之一。
 * 据此识别 Route 元素并抽取 path（相对路径按原样收集，交由 popup 去重）。
 *
 * @param rootFiber - 根 Fiber
 * @returns routes 收集到的路径；mode 为推断出的写法标签
 */
function harvestDeclarativeRoutes(rootFiber: ReactFiberLike | null): { routes: RouteEntry[]; mode: string | null } {
    const routes: RouteEntry[] = [];
    let mode: string | null = null;
    if (!rootFiber) {
        return { routes, mode };
    }

    const queue: ReactFiberLike[] = [rootFiber];
    const visited = new Set<ReactFiberLike>();
    let scanned = 0;

    const isRouteProps = (props: Record<string, any> | undefined): boolean =>
        !!props &&
        typeof props.path === 'string' &&
        ('element' in props || 'component' in props || 'render' in props || 'children' in props);

    while (queue.length && scanned < 6000) {
        const fiber = queue.shift() as ReactFiberLike;
        if (!fiber || visited.has(fiber)) continue;
        visited.add(fiber);
        scanned += 1;

        const props = fiber.memoizedProps as Record<string, any> | undefined;
        if (isRouteProps(props)) {
            const rawPath = typeof props!.path === 'string' ? props!.path : '';
            // v6 用 element，v4/v5 用 component/render —— 据此粗略区分写法
            if (!mode) {
                mode = ('element' in props!) ? 'v6/v7 声明式' : 'v4/v5 声明式';
            }
            // 归一化为绝对路径展示；相对路径直接补前导斜杠
            const path = rawPath.startsWith('/') ? rawPath : ('/' + rawPath);
            routes.push({ name: undefined, path: path.replace(/\/\/+/g, '/'), meta: {} });
        }

        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
    }

    return { routes, mode };
}

/**
 * 枚举 Next.js 客户端路由。
 *
 * - Pages Router：`window.next.router.components` 是以路由路径为 key 的映射，可直接取全部键。
 * - App Router：路由信息多在服务端 manifest，客户端较难全量枚举；
 *   退而取 router.components（若存在）与 __NEXT_DATA__ 的当前 page。
 *
 * @returns 收集到的 Next.js 路由路径
 */
function enumerateNextRoutes(): RouteEntry[] {
    const out: RouteEntry[] = [];

    try {
        const components = (window.next?.router as { components?: Record<string, unknown> } | undefined)?.components;
        if (components && typeof components === 'object') {
            Object.keys(components).forEach(path => {
                if (typeof path === 'string' && path) {
                    out.push({ name: undefined, path: path.startsWith('/') ? path : '/' + path, meta: {} });
                }
            });
        }
    } catch (e) {
        handleError(e, 'enumerateNextRoutes:components');
    }

    try {
        // App Router 的客户端段预加载缓存（不同版本字段名不一，尽力探测）
        const cache = (window.next?.router as Record<string, unknown> | undefined)?.appRouteCache;
        if (cache && typeof cache === 'object') {
            Object.keys(cache).forEach(path => {
                if (typeof path === 'string' && path) {
                    out.push({ name: undefined, path: path.startsWith('/') ? path : '/' + path, meta: {} });
                }
            });
        }
    } catch (e) {
        // 该字段不存在时静默跳过
    }

    return out;
}

/**
 * 多适配器路由收集：按 Next.js → React Router data → TanStack → 声明式 → 锚点 的顺序尝试。
 *
 * 顺序依据「枚举完整度」：能拿到集中路由表的优先，全部落空才用内链兜底。
 * 返回路由库名称与版本标签，供界面展示与报告标注。
 *
 * @param rootFiber - 根 Fiber
 * @returns 路由清单 + 命中的路由库信息 + 是否检测到路由
 */
function collectReactRoutes(rootFiber: ReactFiberLike | null): {
    routes: RouteEntry[];
    routerLib: string;
    routerVersion: string | null;
    detected: boolean;
} {
    // 1. Next.js（存在 window.next 即判定）
    if (window.next) {
        const nextRoutes = enumerateNextRoutes();
        return {
            routes: nextRoutes,
            routerLib: 'Next.js',
            routerVersion: window.next.version || '未知版本',
            detected: nextRoutes.length > 0
        };
    }

    // 2. React Router data router（v6.4+ / v7）
    const dataRouter = detectReactRouterObject(rootFiber);
    if (dataRouter) {
        const routes: RouteEntry[] = [];
        flattenReactRoutes(dataRouter.routes, '', routes);
        // 配置树为空时退化到当前匹配链
        if (!routes.length && Array.isArray(dataRouter.state?.matches)) {
            dataRouter.state!.matches.forEach(match => {
                if (match && typeof match.pathname === 'string') {
                    routes.push({ name: match.routeId, path: match.pathname, meta: {} });
                }
            });
        }
        return { routes, routerLib: 'React Router', routerVersion: 'v6.4+ / v7 data router', detected: true };
    }

    // 3. TanStack Router
    const tanstack = findTanStackRouter(rootFiber);
    if (tanstack) {
        const routes: RouteEntry[] = [];
        collectTanStackRoutes(tanstack, routes);
        return { routes, routerLib: 'TanStack Router', routerVersion: 'data router', detected: true };
    }

    // 4. 声明式 React Router（<Routes>/<Route>、<Switch>）
    const declarative = harvestDeclarativeRoutes(rootFiber);
    if (declarative.routes.length) {
        return { routes: declarative.routes, routerLib: 'React Router', routerVersion: declarative.mode, detected: true };
    }

    // 5. 锚点兜底（自研路由 / 无法静态枚举）
    return {
        routes: collectAnchorRoutes(),
        routerLib: '未知路由库',
        routerVersion: null,
        detected: false
    };
}

/**
 * 执行完整的 React 路由分析（多框架适配版）。
 *
 * 与 performFullAnalysis（Vue）保持同样的结果结构，framework 固定为 'react'：
 *   1. 取出根 Fiber，读 React 版本
 *   2. 依次尝试 Next.js / React Router data / TanStack / 声明式 / 锚点 五类路由来源
 *   3. 记录命中的路由库名称与版本标签
 *   4. 复用页面链接前缀分析推测候选基础路径
 *
 * React 生态没有集中的守卫/meta，本函数只做**只读枚举**；
 * 鉴权绕过统一交由 all-in.js 前置接管。
 *
 * @param element - React 挂载元素
 * @returns 分析结果
 */
export function performReactAnalysis(element: ReactElementLike): RouterAnalysisResult {
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
        routerLib: '',
        routerVersion: null,
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

        const collected = collectReactRoutes(rootFiber);
        result.routerLib = collected.routerLib;
        result.routerVersion = collected.routerVersion;
        result.routerDetected = collected.detected;
        result.allRoutes = collected.routes;

        // 无论如何都把当前路径纳入，保证列表可用、绕路有落点
        pushCurrentPath(result.allRoutes);

        console.log('🔍 路由库：', result.routerLib, result.routerVersion || '', '· 路由数：', result.allRoutes.length);
        if (!collected.detected) {
            console.warn('🚫 未定位到可枚举的路由实例（可能是自研路由 / 声明式嵌套相对路径无法还原）');
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
