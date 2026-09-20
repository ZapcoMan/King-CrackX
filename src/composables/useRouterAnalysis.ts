/**
 * Vue Router 分析结果的获取、缓存与展示。
 *
 * 状态机（panelState）替代了原来「直接往容器里塞 innerHTML」的做法：
 *   loading   —— 分析进行中
 *   error     —— 出错（消息在 panelMessage）
 *   no-vue    —— 页面不是 Vue 应用
 *   no-router —— 是 Vue，但没找到 Vue Router
 *   ready     —— 分析完成，展示版本号与 URL 列表
 *
 * 独立的 routeListState 负责「URL 列表」这一块的三种情形：
 *   none      —— 不该渲染（面板还没 ready）
 *   empty     —— 没有可用路由（消息在 message）
 *   error     —— URL 拼接过程中抛错（典型原因：标签页 URL 非法）
 *   ready     —— 正常，携带完整的 URL 列表数据
 */

import { computed, reactive, ref } from 'vue';
import {
    clearCachedAnalysis,
    readCachedAnalysis,
    readLastOpenedRoute,
    writeCachedAnalysis,
    writeLastOpenedRoute
} from '../utils/storage';
import { dedupeRoutes, getBaseModeKey, normalizeAnalysisResult, normalizeUrl, urlsEqual } from '../utils/url';
import { buildRouteUrlList, extractRouteArray, type RouteUrlList } from '../utils/routeUrls';
import { currentTabId, currentTabUrl } from './useCurrentTab';

export type RouterPanelState = 'loading' | 'error' | 'no-vue' | 'no-router' | 'ready';

export type RouteListState =
    | { kind: 'none' }
    | { kind: 'empty'; message: string }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; list: RouteUrlList };

const vueAnalysisResult = ref<RouterAnalysisResult | null>(null);
const panelState = ref<RouterPanelState>('loading');
const panelMessage = ref('正在分析Vue路由...');
const lastOpenedRoute = ref('');
/** 用户在各站点上手动选择过的 URL 模式（origin -> mode） */
const basePathModeByOrigin = reactive<Record<string, string>>({});

/**
 * 点击「打开」后等待跳转的目标 URL。
 * 用于过滤掉跳转过程中旧页面回传的消息，避免把过期结果覆盖到界面上。
 * 非响应式 —— 它只是消息过滤用的临时标记，不需要触发渲染。
 */
let pendingNavigationUrl = '';

/** 是否处于「已发起跳转、等待新页面」的状态 */
export function hasPendingNavigation(): boolean {
    return !!pendingNavigationUrl;
}

/**
 * 判断一条来自 content.js 的消息是否应当被采纳。
 *
 * 跳转过程中，旧页面可能还会回传分析结果，若直接采用会覆盖掉新页面的数据；
 * 因此当存在待跳转目标、且消息来源页 URL 与之不一致时，直接丢弃。
 */
export function shouldAcceptMessage(senderUrl: string): boolean {
    return !(pendingNavigationUrl && senderUrl && !urlsEqual(senderUrl, pendingNavigationUrl));
}

/** 清空待跳转标记（收到有效结果或错误时调用） */
export function clearPendingNavigation(): void {
    pendingNavigationUrl = '';
}

/** 组合当前标签页 URL 与分析结果，推导出要展示的 URL 列表 */
const routeListState = computed<RouteListState>(() => {
    if (panelState.value !== 'ready') {
        return { kind: 'none' };
    }

    const result = vueAnalysisResult.value;
    const currentUrl = currentTabUrl.value;
    if (!result || !currentUrl) {
        return { kind: 'none' };
    }

    try {
        const extraction = extractRouteArray(result.allRoutes || result);
        if (!extraction.ok) {
            return { kind: 'empty', message: extraction.message };
        }

        if (!dedupeRoutes(extraction.routes).length) {
            return { kind: 'empty', message: '没有找到有效的路由路径' };
        }

        const list = buildRouteUrlList({
            routes: extraction.routes,
            currentUrl,
            lastOpenedRoute: lastOpenedRoute.value,
            modePreference: basePathModeByOrigin[getBaseModeKey(currentUrl)] || '',
            routerBase: result.routerBase || '',
            detectedBasePath: result.pageAnalysis?.detectedBasePath || ''
        });

        return { kind: 'ready', list };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { kind: 'error', message: `displayUrlList执行出错: ${message}` };
    }
});

/** 当前 Vue 版本号（分析结果里没有时显示 Unknown） */
const vueVersionText = computed(() => vueAnalysisResult.value?.vueVersion || 'Unknown');

/** 切换到错误态 */
function showError(message: string): void {
    panelState.value = 'error';
    panelMessage.value = message;
}

/** 切换到加载态 */
function showLoading(message: string): void {
    panelState.value = 'loading';
    panelMessage.value = message;
}

/**
 * 从 localStorage 恢复某个页面的分析结果。
 *
 * @returns 是否成功恢复（用于决定是否保留当前界面、避免闪回加载态）
 */
function restoreFromCache(url: string | undefined): boolean {
    const cached = readCachedAnalysis(url);
    if (!cached?.result) {
        return false;
    }

    const normalized = normalizeAnalysisResult(cached.result);
    vueAnalysisResult.value = normalized;
    panelState.value = normalized.routerDetected ? 'ready' : 'no-router';
    return true;
}

/** 向页面请求一次路由分析 */
function requestAnalysis({ preserveUi = false, forceRefresh = true }: { preserveUi?: boolean; forceRefresh?: boolean } = {}): void {
    const tabId = currentTabId.value;
    if (!tabId) {
        showError('无法获取当前标签页信息');
        return;
    }

    if (!preserveUi || !vueAnalysisResult.value) {
        showLoading('正在分析Vue路由...');
    }

    chrome.tabs.sendMessage(tabId, {
        action: 'analyzeVueRouter',
        forceRefresh
    }, () => {
        if (!chrome.runtime.lastError) {
            return;
        }

        console.warn('分析请求发送失败:', chrome.runtime.lastError.message);

        if (!preserveUi && !vueAnalysisResult.value) {
            showError('无法连接到页面，请刷新后重试。');
        }
    });
}

/** 处理 Vue 检测结果（detector.js 会先报检测、再报完整分析） */
function handleDetectionResult(result: VueDetectionResult): void {
    if (result.detected) {
        if (!vueAnalysisResult.value) {
            showLoading('正在分析Vue路由...');
        }
        return;
    }

    vueAnalysisResult.value = null;
    clearCachedAnalysis(currentTabUrl.value);
    panelState.value = 'no-vue';
}

/** 处理完整路由分析结果：归一化 → 写缓存 → 更新界面 */
function handleAnalysisResult(result: RouterAnalysisResult): void {
    const normalized = normalizeAnalysisResult(result);
    vueAnalysisResult.value = normalized;
    writeCachedAnalysis(currentTabUrl.value, normalized);
    panelState.value = normalized.routerDetected ? 'ready' : 'no-router';
}

/** 切换到指定的 URL 生成模式，并记住该站点的选择 */
function setUrlMode(modeKey: string, mode: string): void {
    if (!modeKey || !['standard', 'base'].includes(mode)) {
        return;
    }

    basePathModeByOrigin[modeKey] = mode;
}

/** 记录并跳转到某条路由 */
function navigateTo(url: string): void {
    const tabId = currentTabId.value;
    if (!tabId) {
        showError('无法获取当前标签页信息');
        return;
    }

    pendingNavigationUrl = normalizeUrl(url);
    writeLastOpenedRoute(currentTabUrl.value, url);

    chrome.tabs.update(tabId, { url }, () => {
        if (chrome.runtime.lastError) {
            pendingNavigationUrl = '';
            showError(`打开失败: ${chrome.runtime.lastError.message}`);
        }
    });
}

/** 页面 URL 变化时同步「上次打开的路由」与缓存 */
function syncForCurrentTab(url: string): void {
    lastOpenedRoute.value = readLastOpenedRoute(url);
}

/** 判断某条 URL 是否就是「当前所在路由」（用于高亮） */
function isCurrentRoute(url: string): boolean {
    return !!(lastOpenedRoute.value && urlsEqual(url, lastOpenedRoute.value));
}

/** 初始化：读缓存 → 请求分析 */
function initRouterAnalysis(): void {
    showLoading('正在分析Vue路由...');
    lastOpenedRoute.value = readLastOpenedRoute(currentTabUrl.value);

    const restored = restoreFromCache(currentTabUrl.value);
    requestAnalysis({ preserveUi: restored, forceRefresh: true });
}

/** 组合式入口（状态为模块级单例） */
export function useRouterAnalysis() {
    return {
        vueAnalysisResult,
        panelState,
        panelMessage,
        vueVersionText,
        routeListState,
        lastOpenedRoute,
        showError,
        showLoading,
        restoreFromCache,
        requestAnalysis,
        handleDetectionResult,
        handleAnalysisResult,
        setUrlMode,
        navigateTo,
        syncForCurrentTab,
        isCurrentRoute,
        initRouterAnalysis,
        hasPendingNavigation,
        shouldAcceptMessage,
        clearPendingNavigation
    };
}
