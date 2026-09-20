/**
 * API 端点提取。
 *
 * 数据流：
 *   点击「提取API」→ 通知 content.js 注入 api-extractor.js
 *                 → 页面脚本不断回传进度（VUECRACK_API_EXTRACT_PROGRESS）
 *                 → 最终回传结果（VUECRACK_API_EXTRACT_RESULT）或错误
 *
 * 与路由分析一样，popup 不等待 sendMessage 的返回值，结果全部靠消息推送。
 */

import { computed, ref } from 'vue';
import {
    buildApiExportFilename,
    buildApiExportText,
    collectAllApiFullUrls,
    copyText,
    downloadTextFile
} from '../utils/apiExport';
import { currentTabId, currentTabUrl } from './useCurrentTab';

const apiExtractResult = ref<ApiExtractResult | null>(null);
/** 提取中的进度文案；null 表示当前不是"提取中"状态 */
const apiProgress = ref<string | null>(null);
/** 提取失败时的错误文案 */
const apiError = ref<string>('');

/** 统计信息：已调用数 / 静态提取数 / 未调用数 / sourcemap 泄露数 */
const apiStats = computed(() => {
    const result = apiExtractResult.value;
    const staticApis = result?.staticApis || [];
    const calledCount = staticApis.filter(item => item.called).length;

    return {
        liveCount: (result?.liveApis || []).length,
        staticCount: staticApis.length,
        uncalledCount: staticApis.length - calledCount,
        sourceMapCount: (result?.sourceMaps || []).length,
        scriptCount: result?.scriptCount || 0,
        inlineScriptCount: result?.inlineScriptCount || 0,
        failedCount: (result?.failedScripts || []).length
    };
});

/** 请求页面开始提取 */
function extractApi(): void {
    const tabId = currentTabId.value;
    if (!tabId) {
        apiError.value = '无法获取当前标签页信息';
        apiProgress.value = null;
        return;
    }

    apiExtractResult.value = null;
    apiError.value = '';
    apiProgress.value = '正在提取API端点...';

    chrome.tabs.sendMessage(tabId, { action: 'extractApi' }, () => {
        if (chrome.runtime.lastError) {
            console.warn('API提取请求发送失败:', chrome.runtime.lastError.message);
            apiProgress.value = null;
            apiError.value = '无法连接到页面，请刷新后重试。';
        }
    });
}

/** 处理进度消息 */
function handleApiProgress(message: string | undefined): void {
    apiProgress.value = message || '正在提取API端点...';
    apiError.value = '';
}

/** 处理最终结果 */
function handleApiResult(result: ApiExtractResult | undefined): void {
    apiExtractResult.value = result || ({} as ApiExtractResult);
    apiProgress.value = null;
    apiError.value = '';
}

/** 处理错误消息 */
function handleApiError(message: string | undefined): void {
    apiProgress.value = null;
    apiError.value = message || '未知错误';
}

/** 复制全部端点的完整 URL（去重），返回复制条数 */
async function copyAllFullUrls(): Promise<number> {
    const urls = collectAllApiFullUrls(apiExtractResult.value);
    const ok = await copyText(urls.join('\n'));
    return ok ? urls.length : -1;
}

/** 导出 TXT 文件 */
function exportTxt(): void {
    downloadTextFile(
        buildApiExportFilename(currentTabUrl.value),
        buildApiExportText(apiExtractResult.value)
    );
}

/** 复制完整 JSON 结果 */
async function copyJson(): Promise<boolean> {
    if (!apiExtractResult.value) {
        return false;
    }

    return copyText(JSON.stringify(apiExtractResult.value, null, 2));
}

/** 组合式入口（状态为模块级单例） */
export function useApiExtract() {
    return {
        apiExtractResult,
        apiProgress,
        apiError,
        apiStats,
        extractApi,
        handleApiProgress,
        handleApiResult,
        handleApiError,
        copyAllFullUrls,
        exportTxt,
        copyJson
    };
}
