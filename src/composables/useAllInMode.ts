/**
 * 「梭哈模式」的开关与状态。
 *
 * 数据流：
 *   开关变化 → 写入 chrome.storage.local 的站点白名单
 *            → 通知 background.js 重新注册动态内容脚本
 *            → 向页面查询实时拦截统计并展示
 *
 * 注意：梭哈模式是**按 hostname** 生效的，所以切换开关只影响当前站点。
 */

import { computed, ref } from 'vue';
import { ALL_IN_SITES_STORAGE_KEY, ALL_IN_STORAGE_KEY, normalizeAllInSites } from '../utils/storage';
import { getAllInSiteKey } from '../utils/url';
import { currentTabId } from './useCurrentTab';

/** 当前站点的 hostname（空串表示该页面不支持梭哈模式） */
const allInSiteKey = ref('');
/** 开关是否处于打开状态 */
const allInEnabled = ref(false);
/** 页面回传的拦截统计 */
const latestAllInStatus = ref<AllInStatus | null>(null);
/** 是否已从 storage 读取过初始值（未读完时状态行显示"读取状态中..."） */
const allInLoaded = ref(false);

/** 当前页面是否支持梭哈模式（非 http/https 页面不支持） */
const allInSupported = computed(() => !!allInSiteKey.value);

/** 状态行文案；分支顺序与原 renderAllInStatus 完全一致 */
const allInStatusText = computed(() => {
    if (!allInLoaded.value) {
        return '读取状态中...';
    }

    if (!allInSupported.value) {
        return '当前页面不支持';
    }

    if (!allInEnabled.value) {
        return '已关闭';
    }

    if (latestAllInStatus.value?.injected) {
        const status = latestAllInStatus.value;
        const guardCount = status.guardRegistrationBlocked || 0;
        const routerJumpCount = status.routerJumpBlocked || 0;
        const browserJumpCount = status.browserJumpBlocked || 0;
        return `已注入 · 守卫 ${guardCount} · Router ${routerJumpCount} · 浏览器 ${browserJumpCount}`;
    }

    return '已开启，刷新后生效';
});

/**
 * 依据当前页面 URL 初始化开关状态。
 *
 * @param pageUrl - 当前标签页 URL
 */
async function initAllInMode(pageUrl: string | undefined): Promise<void> {
    allInSiteKey.value = getAllInSiteKey(pageUrl);

    if (!allInSiteKey.value) {
        allInEnabled.value = false;
        latestAllInStatus.value = null;
        allInLoaded.value = true;
        return;
    }

    try {
        const result = await chrome.storage.local.get([ALL_IN_SITES_STORAGE_KEY]);
        const sites = normalizeAllInSites(result[ALL_IN_SITES_STORAGE_KEY]);
        allInEnabled.value = sites[allInSiteKey.value] === true;
    } catch (error) {
        console.warn('读取梭哈模式站点设置失败:', error);
        allInEnabled.value = false;
    }

    latestAllInStatus.value = null;
    allInLoaded.value = true;
}

/**
 * 切换当前站点的梭哈模式。
 *
 * 写入白名单后主动通知 background.js 立即同步，避免等待 storage 变更监听，
 * 这样用户切换后马上刷新页面就能生效。
 *
 * @param value - 目标开关状态
 */
async function setAllInEnabled(value: boolean): Promise<void> {
    const siteKey = allInSiteKey.value;

    if (!siteKey) {
        allInEnabled.value = false;
        return;
    }

    allInEnabled.value = value;
    latestAllInStatus.value = null;

    try {
        const result = await chrome.storage.local.get([ALL_IN_SITES_STORAGE_KEY]);
        const sites = normalizeAllInSites(result[ALL_IN_SITES_STORAGE_KEY]);

        if (value) {
            sites[siteKey] = true;
        } else {
            delete sites[siteKey];
        }

        await chrome.storage.local.set({
            [ALL_IN_STORAGE_KEY]: false,
            [ALL_IN_SITES_STORAGE_KEY]: sites
        });
    } catch (error) {
        console.warn('保存梭哈模式站点设置失败:', error);
        return;
    }

    try {
        await chrome.runtime.sendMessage({ action: 'syncAllInMode' });
    } catch (error) {
        // 后台未就绪（无接收方）时不同步状态，与原实现的 lastError 分支一致
        return;
    }

    requestAllInStatus();
}

/**
 * 向页面查询实时拦截统计。
 *
 * 页面脚本不一定存在（未开启梭哈模式、或页面还没刷新），
 * 此时 sendMessage 会失败 —— 读取 lastError 即可静默跳过。
 */
function requestAllInStatus(): void {
    const tabId = currentTabId.value;
    if (!tabId) {
        return;
    }

    chrome.tabs.sendMessage(tabId, { action: 'getAllInStatus' }, () => {
        void chrome.runtime.lastError;
    });
}

/** 处理页面回传的拦截统计 */
function handleAllInStatus(status: AllInStatus | undefined): void {
    latestAllInStatus.value = status || null;
}

/** 组合式入口（状态为模块级单例） */
export function useAllInMode() {
    return {
        allInSiteKey,
        allInEnabled,
        allInSupported,
        allInStatusText,
        latestAllInStatus,
        initAllInMode,
        setAllInEnabled,
        requestAllInStatus,
        handleAllInStatus
    };
}
