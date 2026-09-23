/**
 * 安全审计报告导出为 Markdown 格式。
 */

import type { SecurityAuditReport, SensitiveApiDetection, RoutePermissionAnalysis } from './securityAudit';

const RISK_ICONS: Record<string, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🟢',
    safe: '✅'
};

const RISK_LABELS: Record<string, string> = {
    critical: '严重',
    high: '高危',
    medium: '中危',
    low: '低危',
    safe: '安全'
};

function escapeMarkdown(text: string): string {
    return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function groupByCategory(apis: SensitiveApiDetection[]): Record<string, SensitiveApiDetection[]> {
    const groups: Record<string, SensitiveApiDetection[]> = {};
    for (const api of apis) {
        if (!groups[api.category]) {
            groups[api.category] = [];
        }
        groups[api.category].push(api);
    }
    return groups;
}

export function generateSecurityReportMarkdown(report: SecurityAuditReport): string {
    const lines: string[] = [];
    const date = new Date(report.timestamp).toLocaleString('zh-CN');

    lines.push('# King-CrackX 安全审计报告');
    lines.push('');
    lines.push('**生成时间**: ' + date);
    lines.push('**目标页面**: ' + report.pageUrl);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## 审计摘要');
    lines.push('');
    const icon = RISK_ICONS[report.summary.overallRisk] || '';
    const label = RISK_LABELS[report.summary.overallRisk] || '';
    lines.push('**整体风险等级**: ' + icon + ' ' + label);
    lines.push('');
    lines.push('| 指标 | 数量 |');
    lines.push('|------|------|');
    lines.push('| 敏感 API 总数 | ' + report.summary.sensitiveApiCount + ' |');
    lines.push('| 严重风险 | ' + report.summary.criticalCount + ' |');
    lines.push('| 高危 | ' + report.summary.highCount + ' |');
    lines.push('| 中危 | ' + report.summary.mediumCount + ' |');
    lines.push('| 低危 | ' + report.summary.lowCount + ' |');
    lines.push('| 路由总数 | ' + report.summary.totalRoutes + ' |');
    lines.push('| 已保护路由 | ' + report.summary.protectedRoutes + ' |');
    lines.push('| 未保护路由 | ' + report.summary.unprotectedRoutes + ' |');
    lines.push('| Sourcemap 泄露 | ' + report.summary.sourceMapLeakCount + ' |');
    lines.push('');
    lines.push('---');
    lines.push('');

    if (report.sensitiveApis.length > 0) {
        lines.push('## 敏感 API 检测结果');
        lines.push('');
        lines.push('共发现 **' + report.sensitiveApis.length + '** 个敏感 API 端点');
        lines.push('');

        const grouped = groupByCategory(report.sensitiveApis);

        for (const category of Object.keys(grouped)) {
            const apis = grouped[category];
            lines.push('### ' + category + ' (' + apis.length + ' 个)');
            lines.push('');
            lines.push('| 路径 | 完整 URL | 风险等级 | 匹配关键词 | 来源 |');
            lines.push('|------|----------|----------|------------|------|');

            for (const api of apis) {
                const aIcon = RISK_ICONS[api.riskLevel] || '';
                const aLabel = RISK_LABELS[api.riskLevel] || '';
                const sourceLabel = api.source === 'live' ? '已调用' : '静态提取';
                lines.push('| ' + escapeMarkdown(api.path) + ' | ' + escapeMarkdown(api.fullUrl) + ' | ' + aIcon + ' ' + aLabel + ' | ' + api.matchedKeyword + ' | ' + sourceLabel + ' |');
            }

            lines.push('');
        }
    } else {
        lines.push('## 敏感 API 检测结果');
        lines.push('');
        lines.push('未发现敏感 API 端点');
        lines.push('');
    }

    lines.push('---');
    lines.push('');

    if (report.unauthorizedRoutes.length > 0) {
        lines.push('## 未授权访问路径');
        lines.push('');
        lines.push('共发现 **' + report.unauthorizedRoutes.length + '** 个未受保护的路由');
        lines.push('');
        lines.push('| 路径 | 路由名称 | 风险等级 | 风险描述 |');
        lines.push('|------|----------|----------|----------|');

        for (const route of report.unauthorizedRoutes) {
            const rIcon = RISK_ICONS[route.riskLevel] || '';
            const rLabel = RISK_LABELS[route.riskLevel] || '';
            const name = route.name || '-';
            lines.push('| ' + escapeMarkdown(route.path) + ' | ' + escapeMarkdown(name) + ' | ' + rIcon + ' ' + rLabel + ' | ' + route.riskDescription + ' |');
        }

        lines.push('');
    } else {
        lines.push('## 未授权访问路径');
        lines.push('');
        lines.push('所有路由均有权限保护');
        lines.push('');
    }

    lines.push('---');
    lines.push('');

    if (report.sourceMapRisks.length > 0) {
        lines.push('## Sourcemap 泄露风险');
        lines.push('');
        lines.push('共发现 **' + report.sourceMapRisks.length + '** 个 Sourcemap 泄露');
        lines.push('');
        lines.push('| Sourcemap URL | 脚本 URL | 风险等级 | 说明 |');
        lines.push('|---------------|-----------|----------|------|');

        for (const sm of report.sourceMapRisks) {
            const smIcon = RISK_ICONS[sm.riskLevel] || '';
            const smLabel = RISK_LABELS[sm.riskLevel] || '';
            lines.push('| ' + escapeMarkdown(sm.mapUrl) + ' | ' + escapeMarkdown(sm.scriptUrl) + ' | ' + smIcon + ' ' + smLabel + ' | ' + sm.description + ' |');
        }

        lines.push('');
    } else {
        lines.push('## Sourcemap 泄露风险');
        lines.push('');
        lines.push('未发现 Sourcemap 泄露');
        lines.push('');
    }

    lines.push('---');
    lines.push('');

    if (report.recommendations.length > 0) {
        lines.push('## 安全建议');
        lines.push('');
        for (const rec of report.recommendations) {
            lines.push('- ' + rec);
        }
        lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('*本报告由 King-CrackX Chrome 扩展自动生成*');

    return lines.join('\n');
}

export function buildSecurityReportFilename(pageUrl: string): string {
    let host = 'site';
    try {
        host = new URL(pageUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    } catch (e) {
        // ignore
    }

    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    return 'king-crackx-security-' + host + '-' + stamp + '.md';
}

export function downloadMarkdownFile(filename: string, text: string): void {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function copyMarkdownToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) {
        return false;
    }
}