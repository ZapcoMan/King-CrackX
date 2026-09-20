/**
 * 路由 → 完整 URL 的生成规则。
 *
 * 这是 popup 最核心的业务逻辑，从原 popup.js 的 displayUrlList() 中原样搬运，
 * 只做了两件事：拆成纯函数、把原本散落在闭包里的中间变量收进一个结果对象。
 * **URL 拼接规则一个字都没有改动**，包括各种边界分支。
 *
 * 背景知识（决定了这里的复杂分支）：
 *   - Hash 模式：真实路径在 # 之后，形如 https://site/#/a/b
 *   - History 模式：真实路径就是 pathname，形如 https://site/a/b
 *   - 部署在子目录时（base 非空），History 模式下还要再拼一层前缀
 */

import {
    dedupeRoutes,
    dedupeUrlItems,
    getBaseModeKey,
    normalizeBasePath,
    normalizeRoutePath,
    urlsEqual,
    type UrlItem
} from './url';

/** URL 生成模式 */
export type UrlMode = 'standard' | 'base';

/** 路由列表的提取结果 */
export type RouteArrayExtraction =
    | { ok: true; routes: RouteEntry[] }
    | { ok: false; message: string };

/**
 * 从任意形态的分析结果中提取路由数组。
 *
 * 需要兼容三种输入，因为数据可能来自缓存（结构可能有历史遗留）：
 *   - 直接是数组
 *   - 含 allRoutes 字段的结果对象
 *   - 以 path 为 key 的普通对象
 */
export function extractRouteArray(routes: RouteEntry[] | RouterAnalysisResult | null | undefined): RouteArrayExtraction {
    if (!routes) {
        return { ok: false, message: '没有找到路由路径' };
    }

    let routeArray: RouteEntry[] = [];

    if (Array.isArray(routes)) {
        routeArray = routes;
    } else if (routes.allRoutes && Array.isArray(routes.allRoutes)) {
        routeArray = routes.allRoutes;
    } else if (typeof routes === 'object') {
        // 形如 { "/home": { path: "/home", name: "home" } } 的旧结构
        const record = routes as unknown as Record<string, any>;
        routeArray = Object.keys(record).map(key => {
            const route = record[key];
            return {
                path: route.path || key,
                name: route.name || key
            };
        });
    } else {
        return { ok: false, message: '路由数据格式错误' };
    }

    return { ok: true, routes: routeArray };
}

/** 一次 URL 列表构建的完整结果，供界面直接消费 */
export interface RouteUrlList {
    /** 当前生效的模式 */
    mode: UrlMode;
    /** 是否允许切换到「带基础路径」模式（History 模式且存在可用基础路径） */
    canUseBaseMode: boolean;
    /** 可信基础路径（来自 router.options.base） */
    trustedBasePath: string;
    /** 候选基础路径（来自页面链接统计） */
    candidateBasePath: string;
    /** 实际可用的基础路径 = 可信优先，其次候选 */
    availableBasePath: string;
    /** 该站点的模式记忆键（origin） */
    modeKey: string;
    /** 列表区标题 */
    sectionTitle: string;
    /** 模式切换按钮的文案 */
    baseModeLabel: string;
    /** 最终要展示的 URL 条目 */
    items: UrlItem[];
}

/**
 * 依据路由表与当前页面地址，构建出可点击的完整 URL 列表。
 *
 * @param routes - 路由条目（内部会再做一次去重，与原实现一致）
 * @param currentUrl - 当前标签页 URL
 * @param lastOpenedRoute - 该站点上次打开过的路由（用于自动选择模式与高亮）
 * @param modePreference - 用户在该站点上手动选择过的模式（空串表示未选过）
 * @param routerBase - 分析结果里的 router.options.base（可信基础路径）
 * @param detectedBasePath - 分析结果里由页面链接推测出的基础路径（候选值）
 */
export function buildRouteUrlList(params: {
    routes: RouteEntry[];
    currentUrl: string;
    lastOpenedRoute: string;
    modePreference: string;
    routerBase: unknown;
    detectedBasePath: unknown;
}): RouteUrlList {
    const { currentUrl, lastOpenedRoute, modePreference } = params;
    const validRoutes = dedupeRoutes(params.routes);

    const urlObj = new URL(currentUrl);
    const domainBase = urlObj.origin;

    // Hash 模式下 baseUrl 截到 '#' 为止（含），History 模式下就是 origin
    let baseUrl = '';
    let isHistoryMode = false;

    if (currentUrl.includes('#/') || currentUrl.includes('#')) {
        const hashIndex = currentUrl.indexOf('#');
        baseUrl = currentUrl.substring(0, hashIndex + 1);
    } else {
        isHistoryMode = true;
        baseUrl = domainBase;
    }

    const paths = validRoutes
        .map(route => route.path)
        .filter((path): path is string => Boolean(path));

    // 可信基础路径优先；只有拿不到可信值时，才退而使用页面链接推测出的候选值
    const trustedBasePath = normalizeBasePath(params.routerBase);
    const candidateBasePath = trustedBasePath ? '' : normalizeBasePath(params.detectedBasePath);
    const availableBasePath = trustedBasePath || candidateBasePath;
    const canUseBaseMode = !!(isHistoryMode && availableBasePath);
    const modeKey = getBaseModeKey(currentUrl);
    const defaultMode: UrlMode = trustedBasePath ? 'base' : 'standard';

    /**
     * 拼接单条路由的完整 URL。
     *
     * @param path - 路由 path
     * @param modeBasePath - 该模式下要附加的基础路径，空串表示标准模式
     */
    function buildUrl(path: string, modeBasePath: string = ''): string {
        const normalizedPath = normalizeRoutePath(path);
        const cleanPath = normalizedPath === '/' ? '' : normalizedPath.substring(1);

        if (isHistoryMode) {
            if (modeBasePath) {
                // 路由本身已经带了基础路径前缀时不再重复拼接
                if (normalizedPath === modeBasePath || normalizedPath.startsWith(`${modeBasePath}/`)) {
                    return `${baseUrl}${normalizedPath}`;
                }

                return `${baseUrl}${modeBasePath}${cleanPath ? `/${cleanPath}` : ''}`;
            }

            return `${baseUrl}${cleanPath ? `/${cleanPath}` : '/'}`;
        }

        // Hash 模式：注意 baseUrl 结尾可能是 '#' 或 '#/'
        if (baseUrl.endsWith('#')) {
            return `${baseUrl}/${cleanPath}`;
        }

        if (baseUrl.endsWith('#/')) {
            return `${baseUrl}${cleanPath}`;
        }

        return `${baseUrl}#/${cleanPath}`;
    }

    const standardUrls = dedupeUrlItems(paths.map(path => ({
        path,
        url: buildUrl(path)
    })));
    const baseModeUrls = canUseBaseMode ? dedupeUrlItems(paths.map(path => ({
        path,
        url: buildUrl(path, availableBasePath)
    }))) : [];

    let activeMode: string = canUseBaseMode ? (modePreference || '') : 'standard';

    // 用户没选过模式时，用「上次打开的路由」反推他上次用的是哪种模式
    if (!activeMode && lastOpenedRoute && canUseBaseMode) {
        if (baseModeUrls.some(item => urlsEqual(item.url, lastOpenedRoute))) {
            activeMode = 'base';
        } else if (standardUrls.some(item => urlsEqual(item.url, lastOpenedRoute))) {
            activeMode = 'standard';
        }
    }

    if (!activeMode) {
        activeMode = canUseBaseMode ? defaultMode : 'standard';
    }

    // 兜底：记忆值非法、或已不允许 base 模式时，回落到默认模式
    if (!['standard', 'base'].includes(activeMode) || (activeMode === 'base' && !canUseBaseMode)) {
        activeMode = canUseBaseMode ? defaultMode : 'standard';
    }

    const mode = activeMode as UrlMode;
    const baseModeLabel = trustedBasePath ? `带基础路径 ${trustedBasePath}` : `候选 ${candidateBasePath}`;
    const sectionTitle = mode === 'base'
        ? (trustedBasePath ? `带基础路径URL：${trustedBasePath}` : `候选基础路径URL：${candidateBasePath}`)
        : '标准URL';

    return {
        mode,
        canUseBaseMode,
        trustedBasePath,
        candidateBasePath,
        availableBasePath,
        modeKey,
        sectionTitle,
        baseModeLabel,
        items: mode === 'base' ? baseModeUrls : standardUrls
    };
}
