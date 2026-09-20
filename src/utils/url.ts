/**
 * popup 侧的 URL / 路径处理工具。
 *
 * 这里全部是从原 popup.js 原样迁移过来的纯函数 —— 不做任何"顺手优化"，
 * 以保证生成的 URL、路由去重结果与重构前逐字节一致。
 *
 * 注意：原实现里有一个 escapeHtml()，在 Vue 版本中已删除 ——
 * Vue 模板的插值（{{ }}）与属性绑定（:title / :data-*）会自动做 HTML 转义，
 * 手工转义反而会导致双重转义。
 */

/** 待生成 URL 的条目（路由路径 + 拼好的完整地址） */
export interface UrlItem {
    path: string;
    url: string;
}

/**
 * 清理 URL 中的冗余斜杠与结尾斜杠，便于比较。
 * 例如 "https://a.com//b/" -> "https://a.com/b"
 * 注意保留协议后的 "://"，只合并路径部分的重复斜杠。
 */
export function cleanUrl(url: string): string {
    return url.replace(/([^:]\/)\/+/g, '$1').replace(/\/$/, '');
}

/** 归一化任意输入为可比较的 URL 字符串；非字符串一律返回空串 */
export function normalizeUrl(url: unknown): string {
    if (!url || typeof url !== 'string') {
        return '';
    }

    return cleanUrl(url.trim());
}

/** 按归一化结果比较两个 URL 是否等价 */
export function urlsEqual(left: string | undefined, right: string | undefined): boolean {
    return normalizeUrl(left) === normalizeUrl(right);
}

/**
 * 归一化 Router 的基础路径。
 *
 * 会剔除：空白、反斜杠、域名形式、query、hash、结尾斜杠；
 * 无法作为路径前缀的情况一律返回空串（表示"不可用"）。
 */
export function normalizeBasePath(basePath: unknown): string {
    if (!basePath || typeof basePath !== 'string') {
        return '';
    }

    let normalized = basePath.trim().replace(/\\/g, '/');

    if (!normalized || normalized === '/' || normalized.includes('#')) {
        return '';
    }

    if (/^[a-z][a-z\d+.-]*:\/\//i.test(normalized)) {
        return '';
    }

    const queryIndex = normalized.indexOf('?');
    if (queryIndex >= 0) {
        normalized = normalized.substring(0, queryIndex);
    }

    if (!normalized.startsWith('/')) {
        normalized = `/${normalized}`;
    }

    normalized = cleanUrl(normalized);
    return normalized === '/' ? '' : normalized;
}

/**
 * 取「URL 生成模式」的记忆键。
 * 用 origin 作为键，使同一站点下的记忆可以跨路径复用。
 */
export function getBaseModeKey(url: string): string {
    try {
        return new URL(url).origin;
    } catch (error) {
        return normalizeUrl(url);
    }
}

/** 把一个完整 URL 拆成「域名 + 路径」两部分，用于界面上分色展示 */
export function splitUrlForDisplay(url: string): { domain: string; path: string } {
    try {
        const parsed = new URL(url);
        return {
            domain: parsed.origin,
            path: `${parsed.pathname}${parsed.search}${parsed.hash}` || '/'
        };
    } catch (error) {
        return {
            domain: '',
            path: url || ''
        };
    }
}

/**
 * 从页面 URL 中取出「梭哈模式」的站点键（纯 hostname，小写）。
 * 非 http/https 或解析失败时返回空串，表示该页面不支持梭哈模式。
 */
export function getAllInSiteKey(url: string | undefined): string {
    try {
        const parsed = new URL(url as string);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
            return '';
        }

        return parsed.hostname.toLowerCase();
    } catch (error) {
        return '';
    }
}

/** 把路由 path 归一化为以 / 开头、无结尾斜杠的形式 */
export function normalizeRoutePath(path: unknown): string {
    if (!path || typeof path !== 'string') {
        return '/';
    }

    const trimmed = path.trim();
    if (!trimmed) {
        return '/';
    }

    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return cleanUrl(withLeadingSlash) || '/';
}

/**
 * 路由去重（按归一化后的 path）。
 * 顺带过滤掉结构不合法（缺 path）的条目，并统一 path 形式。
 */
export function dedupeRoutes(routes: RouteEntry[]): RouteEntry[] {
    const seenPaths = new Set<string>();

    return routes.reduce<RouteEntry[]>((accumulator, route) => {
        if (!route || typeof route !== 'object' || !route.path || typeof route.path !== 'string') {
            return accumulator;
        }

        const normalizedPath = normalizeRoutePath(route.path);
        if (seenPaths.has(normalizedPath)) {
            return accumulator;
        }

        seenPaths.add(normalizedPath);
        accumulator.push({
            ...route,
            path: normalizedPath
        });
        return accumulator;
    }, []);
}

/** URL 去重（按归一化结果），并把 item.url 就地替换成归一化后的值 */
export function dedupeUrlItems(items: UrlItem[]): UrlItem[] {
    const seenUrls = new Set<string>();

    return items.filter(item => {
        const normalized = normalizeUrl(item?.url || '');
        if (!normalized || seenUrls.has(normalized)) {
            return false;
        }

        seenUrls.add(normalized);
        item.url = normalized;
        return true;
    });
}

/**
 * 归一化整份路由分析结果：
 * 去重路由并补上 routeCount，供界面显示「N 条路由」。
 */
export function normalizeAnalysisResult(result: RouterAnalysisResult | null | undefined): RouterAnalysisResult {
    if (!result || typeof result !== 'object') {
        return result as unknown as RouterAnalysisResult;
    }

    const normalizedRoutes = dedupeRoutes(Array.isArray(result.allRoutes) ? result.allRoutes : []);

    return {
        ...result,
        allRoutes: normalizedRoutes,
        routeCount: normalizedRoutes.length
    };
}
