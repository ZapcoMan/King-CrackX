/**
 * popup 侧对 localStorage / chrome.storage 的读写封装。
 *
 * 两类存储的职责严格区分：
 *   - localStorage：缓存「分析结果」与「上次打开的路由」，属于界面加速数据，
 *     丢失只会导致重新分析，不影响功能。
 *   - chrome.storage.local：保存「梭哈模式站点白名单」，属于功能配置，
 *     由 background.js 监听后动态注册内容脚本。
 */

import { normalizeUrl } from './url';

/** 分析结果缓存键前缀 */
const ANALYSIS_CACHE_PREFIX = 'vuecrack_analysis_cache:';
/** 上次打开路由的记忆键前缀 */
const LAST_OPENED_ROUTE_PREFIX = 'vuecrack_last_opened_route:';
/** 旧版本遗留的全局开关键（仍在写 false 做兼容清理） */
export const ALL_IN_STORAGE_KEY = 'vuecrack_all_in_enabled';
/** 当前生效的梭哈模式站点白名单键，结构 { "example.com": true } */
export const ALL_IN_SITES_STORAGE_KEY = 'vuecrack_all_in_sites';

/** 分析缓存最多保留的条数（超出按 savedAt 淘汰最旧） */
const MAX_CACHE_ENTRIES = 15;
/** 路由记忆最多保留的条数 */
const MAX_ROUTE_MEMORY_ENTRIES = 50;

/** localStorage 中保存的单条分析缓存 */
export interface CachedAnalysis {
    url?: string;
    savedAt?: number;
    result?: RouterAnalysisResult;
}

function getCacheKey(url: string): string {
    return `${ANALYSIS_CACHE_PREFIX}${encodeURIComponent(normalizeUrl(url))}`;
}

/**
 * 取路由记忆的键。
 * 以 origin 为粒度 —— 同一站点下不同页面共享「上次打开的路由」，
 * 这样切换页面后仍能高亮之前访问过的那条。
 */
function getRouteMemoryKey(url: string | undefined): string {
    try {
        const parsed = new URL(url as string);
        return `${LAST_OPENED_ROUTE_PREFIX}${parsed.origin}`;
    } catch (error) {
        return `${LAST_OPENED_ROUTE_PREFIX}${encodeURIComponent(normalizeUrl(url))}`;
    }
}

/** 收集某一前缀下的所有条目（解析失败的直接删掉，避免脏数据长期占用） */
function collectEntries(prefix: string, parseSavedAt: (raw: string) => number): Array<{ key: string; savedAt: number }> {
    const entries: Array<{ key: string; savedAt: number }> = [];

    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(prefix)) {
            continue;
        }

        const raw = localStorage.getItem(key) as string;
        entries.push({ key, savedAt: parseSavedAt(raw) });
    }

    return entries;
}

/** 按条数上限淘汰最旧的记录 */
function pruneByLimit(entries: Array<{ key: string; savedAt: number }>, limit: number): void {
    if (entries.length <= limit) {
        return;
    }

    entries
        .sort((a, b) => b.savedAt - a.savedAt)
        .slice(limit)
        .forEach(entry => localStorage.removeItem(entry.key));
}

/** 清理分析缓存，只保留最近 MAX_CACHE_ENTRIES 条 */
export function pruneAnalysisCache(): void {
    try {
        const entries = collectEntries(ANALYSIS_CACHE_PREFIX, raw => {
            try {
                const parsed = JSON.parse(raw) as CachedAnalysis | null;
                return parsed?.savedAt || 0;
            } catch (error) {
                // 解析失败视为 0（最旧），会被优先淘汰
                return 0;
            }
        });

        pruneByLimit(entries, MAX_CACHE_ENTRIES);
    } catch (error) {
        console.warn('清理分析缓存失败:', error);
    }
}

/** 清理路由记忆，只保留最近 MAX_ROUTE_MEMORY_ENTRIES 条 */
export function pruneRouteMemory(): void {
    try {
        const entries = collectEntries(LAST_OPENED_ROUTE_PREFIX, raw => {
            try {
                const parsed = raw ? JSON.parse(raw) as { savedAt?: number } | null : null;
                return parsed?.savedAt || 0;
            } catch (error) {
                return 0;
            }
        });

        pruneByLimit(entries, MAX_ROUTE_MEMORY_ENTRIES);
    } catch (error) {
        console.warn('清理上次打开路由缓存失败:', error);
    }
}

/** 读取某个页面的分析缓存；无缓存或结构不完整时返回 null */
export function readCachedAnalysis(url: string | undefined): CachedAnalysis | null {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
        return null;
    }

    try {
        const cached = localStorage.getItem(getCacheKey(normalizedUrl));
        if (!cached) {
            return null;
        }

        const parsed = JSON.parse(cached) as CachedAnalysis | null;
        return parsed?.result ? parsed : null;
    } catch (error) {
        console.warn('读取分析缓存失败:', error);
        return null;
    }
}

/** 写入分析缓存（带自动淘汰） */
export function writeCachedAnalysis(url: string | undefined, result: RouterAnalysisResult | null): void {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl || !result) {
        return;
    }

    try {
        localStorage.setItem(getCacheKey(normalizedUrl), JSON.stringify({
            url: normalizedUrl,
            savedAt: Date.now(),
            result
        }));

        pruneAnalysisCache();
    } catch (error) {
        console.warn('保存分析缓存失败:', error);
    }
}

/** 删除某个页面的分析缓存（检测到页面不是 Vue 应用时调用） */
export function clearCachedAnalysis(url: string | undefined): void {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
        return;
    }

    try {
        localStorage.removeItem(getCacheKey(normalizedUrl));
    } catch (error) {
        console.warn('清理分析缓存失败:', error);
    }
}

/** 记录「某个站点最近打开过哪条路由」，用于列表高亮与模式自动选择 */
export function writeLastOpenedRoute(pageUrl: string | undefined, routeUrl: string | undefined): void {
    if (!pageUrl || !routeUrl) {
        return;
    }

    try {
        localStorage.setItem(getRouteMemoryKey(pageUrl), JSON.stringify({
            routeUrl: normalizeUrl(routeUrl),
            savedAt: Date.now()
        }));
        pruneRouteMemory();
    } catch (error) {
        console.warn('保存上次打开路由失败:', error);
    }
}

/**
 * 读取「上次打开的路由」。
 * 兼容早期版本的纯字符串格式（那时没包 JSON），解析失败时原样返回。
 */
export function readLastOpenedRoute(pageUrl: string | undefined): string {
    if (!pageUrl) {
        return '';
    }

    try {
        const rawValue = localStorage.getItem(getRouteMemoryKey(pageUrl));
        if (!rawValue) {
            return '';
        }

        try {
            const parsed = JSON.parse(rawValue) as { routeUrl?: string } | null;
            return parsed?.routeUrl || '';
        } catch (error) {
            return rawValue;
        }
    } catch (error) {
        console.warn('读取上次打开路由失败:', error);
        return '';
    }
}

/**
 * 清洗梭哈模式站点白名单：只保留值严格为 true 的条目。
 * 存储里的数据可能被旧版本或手工修改污染，统一归一化后再使用。
 */
export function normalizeAllInSites(value: unknown): Record<string, true> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }

    const source = value as Record<string, unknown>;

    return Object.keys(source).reduce<Record<string, true>>((accumulator, key) => {
        if (source[key] === true) {
            accumulator[key] = true;
        }
        return accumulator;
    }, {});
}
