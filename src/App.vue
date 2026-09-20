<script setup lang="ts">
/**
 * popup 根组件。
 *
 * 职责边界：
 *   - 组装三个面板（梭哈模式 / 路由分析 / API 提取）
 *   - 注册 chrome.* 的消息与标签页事件，并按 action 分发给各组合式函数
 *   - 负责启动流程（取当前标签页 → 初始化梭哈开关 → 恢复缓存 → 请求分析）
 *
 * 三个面板各自从模块级单例状态读取数据，因此这里不需要向下传任何 props。
 */

import { onMounted, watch } from 'vue';
import AllInPanel from './components/AllInPanel.vue';
import RouterPanel from './components/RouterPanel.vue';
import ApiPanel from './components/ApiPanel.vue';
import { currentTabId, currentTabUrl, queryActiveTab } from './composables/useCurrentTab';
import { useAllInMode } from './composables/useAllInMode';
import { useRouterAnalysis } from './composables/useRouterAnalysis';
import { useApiExtract } from './composables/useApiExtract';

const {
    initAllInMode,
    requestAllInStatus,
    handleAllInStatus
} = useAllInMode();

const {
    vueAnalysisResult,
    showError,
    restoreFromCache,
    requestAnalysis,
    handleDetectionResult,
    handleAnalysisResult,
    syncForCurrentTab,
    shouldAcceptMessage,
    clearPendingNavigation
} = useRouterAnalysis();

const {
    handleApiProgress,
    handleApiResult,
    handleApiError
} = useApiExtract();

/**
 * 标题图标路径。
 *
 * 必须用动态绑定（:src）而不是静态 src：
 *   静态 src 会被 Vite 当作「模块引用」去源码目录里解析并尝试打包，
 *   而这张图标是扩展的运行期资源（放在 dist/icons/，由 copy-static 负责搬运），
 *   不参与打包。用 /icons/... 这种扩展根绝对路径，浏览器会解析为
 *   chrome-extension://<id>/icons/icon256.png。
 */
const ICON_URL = '/icons/icon256.png';

/** content.js → popup 的消息载荷 */
interface RuntimeMessage {
    action?: string;
    result?: RouterAnalysisResult | ApiExtractResult | VueDetectionResult;
    error?: string;
    message?: string;
    status?: AllInStatus;
}

/** 页面 URL 变化时同步「上次打开的路由」记忆 */
watch(currentTabUrl, url => {
    syncForCurrentTab(url);
}, { immediate: true });

/** 处理来自 content.js 的消息 */
function handleRuntimeMessage(request: RuntimeMessage, sender: chrome.runtime.MessageSender): void {
    try {
        if (!sender?.tab || currentTabId.value === null || sender.tab.id !== currentTabId.value) {
            return;
        }

        const senderUrl = sender.tab.url || '';

        // 跳转过程中丢弃旧页面回传的过期消息
        if (!shouldAcceptMessage(senderUrl)) {
            return;
        }

        if (senderUrl) {
            currentTabUrl.value = senderUrl;
        }

        switch (request.action) {
            case 'vueDetectionResult':
                handleDetectionResult(request.result as VueDetectionResult);
                break;
            case 'vueRouterAnalysisResult':
                handleAnalysisResult(request.result as RouterAnalysisResult);
                clearPendingNavigation();
                break;
            case 'vueDetectionError':
            case 'vueRouterAnalysisError':
                showError(request.error || '检测过程中发生错误');
                clearPendingNavigation();
                break;
            case 'vuecrackAllInStatus':
                handleAllInStatus(request.status);
                break;
            case 'vuecrackApiProgress':
                handleApiProgress(request.message);
                break;
            case 'vuecrackApiResult':
                handleApiResult(request.result as ApiExtractResult);
                break;
            case 'vuecrackApiError':
                handleApiError(request.error);
                break;
        }
    } catch (error) {
        console.error('消息处理出错:', error);
    }
}

/** 当前标签页加载完成时重新分析 */
function handleTabUpdated(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void {
    if (currentTabId.value === null || tabId !== currentTabId.value) {
        return;
    }

    if (changeInfo.url) {
        currentTabUrl.value = changeInfo.url;
    }

    if (changeInfo.status !== 'complete') {
        return;
    }

    currentTabUrl.value = tab?.url || currentTabUrl.value;

    const restored = restoreFromCache(currentTabUrl.value);
    requestAnalysis({
        preserveUi: restored || !!vueAnalysisResult.value,
        forceRefresh: true
    });
}

onMounted(async () => {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    chrome.tabs.onUpdated.addListener(handleTabUpdated);

    const tab = await queryActiveTab();
    if (!tab) {
        showError('无法获取当前标签页信息');
        return;
    }

    await initAllInMode(tab.url);

    // 顺序与原实现保持一致：
    // 恢复缓存 → 同步上次打开的路由 → 查询梭哈状态 → 请求一次新分析
    const restored = restoreFromCache(currentTabUrl.value);
    syncForCurrentTab(currentTabUrl.value);
    requestAllInStatus();
    requestAnalysis({ preserveUi: restored, forceRefresh: true });
});
</script>

<template>
    <h2>
        <img :src="ICON_URL" width="20" height="20" alt="VueCrack">
        King-Crack
    </h2>

    <AllInPanel />
    <RouterPanel />
    <ApiPanel />
</template>
