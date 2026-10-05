/**
 * King-CrackX —— 全局类型契约（仅编译期存在，不产生任何运行时输出）
 *
 * 为什么用 `.d.ts` 而不是普通 `.ts` 模块：
 *   manifest 中的 content_scripts / web_accessible_resources 都必须是「普通脚本」，
 *   不能是 ES Module（content script 无法可靠地以 module 形式加载）。
 *   因此所有源码文件都不写 import/export，靠本文件提供的全局声明共享类型。
 *
 * 这些接口只描述「本插件实际会读取的字段」，不是 Vue / Vue Router 的完整类型，
 * 因为我们要访问的全是框架未公开的内部属性（__vue_app__ / __vue__ 等）。
 */

/* ==================== Vue 内部结构（最小可用子集） ==================== */

/** Vue 3 应用实例上被本插件读取到的最小结构 */
interface VueAppLike {
    version?: string;
    config?: {
        globalProperties?: Record<string, any>;
    };
    _instance?: {
        appContext?: {
            config?: {
                globalProperties?: Record<string, any>;
            };
        };
        ctx?: Record<string, any>;
    };
}

/** Vue 2 组件实例上被本插件读取到的最小结构 */
interface VueInstanceLike {
    $root?: VueInstanceLike;
    $router?: VueRouterLike;
    $options?: {
        _base?: { version?: string };
        router?: VueRouterLike;
    };
    _router?: VueRouterLike;
}

/** 挂载了 Vue 内部引用的 DOM 元素（Vue2 与 Vue3 的挂载点属性不同，故并列声明） */
interface VueElementLike extends Element {
    __vue_app__?: VueAppLike;
    __vue__?: VueInstanceLike;
    _vnode?: unknown;
}

/* ==================== Vue Router 内部结构 ==================== */

/** 路由配置对象（RouteRecordRaw / RouteRecord 的公共部分） */
interface RouteConfigLike {
    name?: string;
    path?: string;
    meta?: Record<string, any>;
    children?: RouteConfigLike[];
    [key: string]: unknown;
}

/**
 * Vue Router 实例。
 * 用索引签名兜底：不同大版本会把守卫存放在不同名字的内部属性上，
 * 我们需要用动态 key 去遍历清空（见 all-in.ts 的 clearKnownGuardContainers）。
 */
interface VueRouterLike {
    options?: {
        base?: string;
        routes?: RouteConfigLike[];
    };
    history?: {
        base?: string;
        current?: { matched?: RouteConfigLike[] };
    };
    matcher?: {
        getRoutes?: () => RouteConfigLike[];
        match?: unknown;
    };
    getRoutes?: () => RouteConfigLike[];
    [key: string]: unknown;
}

/* ==================== React 内部结构（最小可用子集） ==================== */

/**
 * React Fiber 节点。
 * 只声明本插件会读取的字段；Fiber 是双向链表 + 树结构，
 * 内部字段（return / sibling / child / stateNode / memoizedState）均为未公开实现，
 * 不同 React 大版本形态略有差异，因此全部按需可选并做运行时校验。
 */
interface ReactFiberLike {
    tag?: number;
    type?: unknown;
    stateNode?: unknown;
    child?: ReactFiberLike | null;
    sibling?: ReactFiberLike | null;
    return?: ReactFiberLike | null;
    alternate?: ReactFiberLike | null;
    memoizedState?: unknown;
    [key: string]: unknown;
}

/** 挂载了 React 内部引用的 DOM 元素（各版本标记属性不同，故并列声明） */
interface ReactElementLike extends Element {
    /** React 18+ createRoot 挂在容器上的 key（后缀随机），值为根 Fiber */
    [key: string]: unknown;
}

/**
 * 发现到的 React Router 对象（主要是 v6.4+ data router）。
 * 用索引签名兜底：不同版本内部字段位置不一致，需动态遍历。
 */
interface ReactRouterLike {
    routes?: ReactRouteConfigLike[];
    dataRoutes?: unknown;
    navigate?: (...args: any[]) => unknown;
    state?: {
        navigation?: unknown;
        matches?: Array<{ routeId?: string; pathname?: string }>;
        location?: unknown;
    };
    __vuecrack_guard_props__?: string[];
    [key: string]: unknown;
}

/** React Router 路由配置（v6 data route / v5 Route 配置的公共部分） */
interface ReactRouteConfigLike {
    path?: string;
    id?: string;
    index?: boolean;
    children?: ReactRouteConfigLike[];
    routes?: ReactRouteConfigLike[];
    [key: string]: unknown;
}

/* ==================== 检测 / 路由分析结果 ==================== */

/** 页面使用的框架类型 */
type FrameworkKind = 'vue' | 'react';

/** 页面脚本回传给 content.ts 的框架检测结果（Vue / React 共用同一结构） */
interface VueDetectionResult {
    detected: boolean;
    method: string;
    /** 命中的框架；缺省视为 'vue'（向后兼容旧缓存与旧消息） */
    framework?: FrameworkKind;
    details?: Record<string, unknown>;
    errorMsg?: string;
}

/**
 * 被改写鉴权 meta 的路由记录。
 * path / name 保持可选：Vue Router 的匿名路由本就没有 name，
 * 原实现是原样透传（不补默认值），此处不改变该行为。
 */
interface ModifiedRoute {
    path?: string;
    name?: string;
}

/**
 * 归一化后的路由条目（popup 只展示这三个字段）。
 * 三个字段均可选，因为原始路由记录中确实可能不存在（如匿名路由无 name）。
 * popup 侧在消费前会做运行时类型校验。
 */
interface RouteEntry {
    name?: string;
    path?: string;
    meta?: Record<string, any>;
}

/** 页面链接前缀统计项 */
interface PrefixStat {
    prefix: string;
    count: number;
}

/** 依据页面链接推测出的基础路径信息 */
interface PageAnalysisResult {
    detectedBasePath: string;
    commonPrefixes: PrefixStat[];
}

/** 被 console 拦截后收集到的日志条目 */
interface AnalysisLogEntry {
    type: 'log' | 'warn' | 'error' | 'table';
    message?: string;
    data?: unknown;
}

/**
 * 路由分析结果。
 * 除 vueDetected / routerDetected 外均可缺省 —— 因为异常分支只会回传
 * { vueDetected, routerDetected, error }，不会补齐其余字段。
 */
interface RouterAnalysisResult {
    vueDetected: boolean;
    routerDetected: boolean;
    /** 命中的框架；缺省视为 'vue'（向后兼容旧缓存） */
    framework?: FrameworkKind;
    /** Vue 版本号（framework === 'vue' 时有值） */
    vueVersion?: string | null;
    /** React 版本号（framework === 'react' 时有值） */
    reactVersion?: string | null;
    /** 命中的路由库名称（React 侧，如 'React Router'、'TanStack Router'、'Next.js'） */
    routerLib?: string;
    /** 路由库版本 / 模式标签（如 'v6 data router'、'声明式'） */
    routerVersion?: string | null;
    logs?: AnalysisLogEntry[];
    modifiedRoutes?: ModifiedRoute[];
    allRoutes?: RouteEntry[];
    routerBase?: string;
    pageAnalysis?: PageAnalysisResult;
    currentPath?: string;
    error?: string;
    routeCount?: number;
}

/** detector.ts 内部使用的「完整」结果形态（各字段在流程内保证已就绪） */
interface FullRouterAnalysis extends RouterAnalysisResult {
    vueVersion: string | null;
    logs: AnalysisLogEntry[];
    modifiedRoutes: ModifiedRoute[];
    allRoutes: RouteEntry[];
    routerBase: string;
    pageAnalysis: PageAnalysisResult;
}

/* ==================== 梭哈模式状态 ==================== */

/** all-in.ts 上报的拦截统计快照 */
interface AllInStatus {
    injected: boolean;
    injectedAt: number;
    routersPatched: number;
    guardRegistrationBlocked: number;
    routerJumpBlocked: number;
    browserJumpBlocked: number;
    lastEvent: string;
}

/* ==================== API 端点提取结果 ==================== */

/** 页面已真实发出的接口请求 */
interface LiveApiItem {
    url: string;
    path: string;
}

/** 从 JS 源码中静态提取到的端点 */
interface StaticApiItem {
    path: string;
    fullUrl: string;
    hasParams: boolean;
    sources: string[];
    called: boolean;
}

/** 探测到的 sourcemap 泄露 */
interface SourceMapLeak {
    scriptUrl: string;
    mapUrl: string;
}

/** API 提取最终结果 */
interface ApiExtractResult {
    pageUrl: string;
    origin: string;
    scriptCount: number;
    inlineScriptCount: number;
    liveApis: LiveApiItem[];
    staticApis: StaticApiItem[];
    sourceMaps: SourceMapLeak[];
    failedScripts: string[];
    extractedAt: number;
}

/** 端点累加器中的一条记录 */
interface ApiEndpointEntry {
    path: string;
    sources: string[];
}

/* ==================== 消息协议 ==================== */

/** popup → content.ts 的指令 */
interface PopupRequest {
    action: string;
    forceRefresh?: boolean;
}

/** 页面脚本 → content.ts 的 postMessage 载荷 */
interface PageScriptMessage {
    type: string;
    source?: string;
    result?: RouterAnalysisResult;
    error?: string;
    message?: string;
    status?: AllInStatus;
}

/* ==================== 全局对象补充声明 ==================== */

interface Window {
    /** UMD 构建下暴露的全局 Vue 构造函数 */
    Vue?: { version?: string };
    /** UMD/全局构建下暴露的全局 React 对象（用于读取 version） */
    React?: { version?: string };
    /** UMD 构建下暴露的全局 VueRouter 构造函数（用于原型级接管） */
    VueRouter?: { prototype?: Record<string, unknown> };
    /** Vue DevTools 注入的钩子，生产环境常见 */
    __VUE_DEVTOOLS_GLOBAL_HOOK__?: { Vue?: { version?: string } };
    /** React DevTools 注入的钩子，含 renderers（部分构建可反查版本） */
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: {
        renderers?: unknown;
        [key: string]: unknown;
    };
    /** React Router 数据路由的服务端注入数据（v6.4+ SSR / prerender） */
    __REACT_ROUTER_DATA__?: {
        url?: string;
        queries?: unknown;
        [key: string]: unknown;
    };
    /** React Router v6.4+ 在 window 上标记激活的 data router 集合 */
    __reactRouter6Active?: unknown;
    /** Next.js 运行时对象（页面存在 window.next，含 version / router / appRouteCache 等） */
    next?: {
        version?: string;
        router?: Record<string, unknown>;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
