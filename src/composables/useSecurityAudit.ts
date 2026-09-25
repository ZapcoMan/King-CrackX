/**
 * 安全审计功能的组合式函数。
 *
 * 数据流：
 *   用户点击「安全审计」→ 读取路由分析结果 + API 提取结果
 *   → 执行安全审计 → 生成报告 → 展示/导出
 *
 * 导出功能会整合所有模块的数据（梭哈模式、路由分析、API提取、安全审计）。
 */

import { computed, ref } from 'vue';
import { performSecurityAudit, sortSensitiveApisByRisk, sortRoutesByRisk, type SecurityAuditReport } from '../utils/securityAudit';
import { generateFullReportMarkdown, generateSecurityReportMarkdown, buildSecurityReportFilename, downloadMarkdownFile, copyMarkdownToClipboard } from '../utils/securityReport';
import { useRouterAnalysis } from './useRouterAnalysis';
import { useApiExtract } from './useApiExtract';
import { useAllInMode } from './useAllInMode';
import { currentTabUrl } from './useCurrentTab';

const auditReport = ref<SecurityAuditReport | null>(null);
const isAuditing = ref(false);
const auditError = ref('');
const exportButtonText = ref('导出完整报告');
const copyReportText = ref('复制报告');

const { vueAnalysisResult } = useRouterAnalysis();
const { apiExtractResult } = useApiExtract();
const { latestAllInStatus } = useAllInMode();

const riskSummary = computed(() => {
    if (!auditReport.value) {
        return null;
    }
    return auditReport.value.summary;
});

const sortedSensitiveApis = computed(() => {
    if (!auditReport.value) {
        return [];
    }
    return sortSensitiveApisByRisk(auditReport.value.sensitiveApis);
});

const sortedUnauthorizedRoutes = computed(() => {
    if (!auditReport.value) {
        return [];
    }
    return sortRoutesByRisk(auditReport.value.unauthorizedRoutes);
});

const riskIconMap: Record<string, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
    safe: '✅'
};

const riskLabelMap: Record<string, string> = {
    critical: '严重',
    high: '高危',
    medium: '中危',
    low: '低危',
    safe: '安全'
};

function runAudit(): void {
    const pageUrl = currentTabUrl.value;
    if (!pageUrl) {
        auditError.value = '无法获取当前页面 URL';
        return;
    }

    const routes = vueAnalysisResult.value?.allRoutes || [];
    const liveApis = apiExtractResult.value?.liveApis || [];
    const staticApis = apiExtractResult.value?.staticApis || [];
    const sourceMaps = apiExtractResult.value?.sourceMaps || [];

    if (routes.length === 0 && liveApis.length === 0 && staticApis.length === 0) {
        auditError.value = '请先进行路由分析或 API 提取';
        return;
    }

    isAuditing.value = true;
    auditError.value = '';
    auditReport.value = null;

    try {
        const report = performSecurityAudit({
            pageUrl,
            liveApis,
            staticApis,
            routes,
            sourceMaps
        });

        auditReport.value = report;
        isAuditing.value = false;
    } catch (error) {
        auditError.value = '审计执行失败: ' + (error instanceof Error ? error.message : String(error));
        isAuditing.value = false;
    }
}

function exportMarkdown(): void {
    const pageUrl = currentTabUrl.value;
    if (!pageUrl) {
        return;
    }

    try {
        const markdown = generateFullReportMarkdown({
            pageUrl,
            allInStatus: latestAllInStatus.value,
            routerAnalysis: vueAnalysisResult.value,
            apiExtract: apiExtractResult.value,
            securityAudit: auditReport.value
        });
        const filename = buildSecurityReportFilename(pageUrl);
        downloadMarkdownFile(filename, markdown);
        exportButtonText.value = '已导出!';
    } catch (error) {
        exportButtonText.value = '导出失败';
    }

    setTimeout(() => {
        exportButtonText.value = '导出完整报告';
    }, 2000);
}

async function copyReport(): Promise<void> {
    const pageUrl = currentTabUrl.value;
    if (!pageUrl) {
        return;
    }

    try {
        const markdown = generateFullReportMarkdown({
            pageUrl,
            allInStatus: latestAllInStatus.value,
            routerAnalysis: vueAnalysisResult.value,
            apiExtract: apiExtractResult.value,
            securityAudit: auditReport.value
        });
        const ok = await copyMarkdownToClipboard(markdown);
        copyReportText.value = ok ? '已复制!' : '复制失败';
    } catch (error) {
        copyReportText.value = '复制失败';
    }

    setTimeout(() => {
        copyReportText.value = '复制报告';
    }, 2000);
}

export function useSecurityAudit() {
    return {
        auditReport,
        isAuditing,
        auditError,
        riskSummary,
        sortedSensitiveApis,
        sortedUnauthorizedRoutes,
        riskIconMap,
        riskLabelMap,
        exportButtonText,
        copyReportText,
        runAudit,
        exportMarkdown,
        copyReport
    };
}