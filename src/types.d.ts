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

/* ==================== 检测 / 路由分析结果 ==================== */

/** 页面脚本回传给 content.ts 的 Vue 检测结果 */
interface VueDetectionResult {
    detected: boolean;
    method: string;
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
    vueVersion?: string | null;
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
    /** UMD 构建下暴露的全局 VueRouter 构造函数（用于原型级接管） */
    VueRouter?: { prototype?: Record<string, unknown> };
    /** Vue DevTools 注入的钩子，生产环境常见 */
    __VUE_DEVTOOLS_GLOBAL_HOOK__?: { Vue?: { version?: string } };
}
