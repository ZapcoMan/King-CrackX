<script setup lang="ts">
import { useSecurityAudit } from '../composables/useSecurityAudit';

const {
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
} = useSecurityAudit();
</script>

<template>
    <div class="security-panel">
        <div class="api-panel-header">
            <div>
                <div class="all-in-title">安全审计</div>
            </div>
            <button class="secondary-btn" @click="runAudit" :disabled="isAuditing">
                {{ isAuditing ? '审计中...' : '开始审计' }}
            </button>
        </div>

        <div>
            <div v-if="isAuditing" class="status-item info">
                <span class="loading-spinner"></span>
                正在执行安全审计...
            </div>

            <div v-else-if="auditError" class="status-item error">
                {{ auditError }}
            </div>

            <template v-else-if="auditReport">
                <div class="security-summary">
                    <div class="summary-header">
                        <span class="risk-badge" :class="'risk-' + riskSummary?.overallRisk">
                            {{ riskIconMap[riskSummary?.overallRisk || 'safe'] }} {{ riskLabelMap[riskSummary?.overallRisk || 'safe'] }}
                        </span>
                    </div>

                    <div class="summary-stats">
                        <div class="stat-item">
                            <span class="stat-label">敏感 API</span>
                            <span class="stat-value">{{ riskSummary?.sensitiveApiCount || 0 }}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">未保护路由</span>
                            <span class="stat-value">{{ riskSummary?.unprotectedRoutes || 0 }}</span>
                        </div>
                        <div class="stat-item">
                            <span class="stat-label">Sourcemap</span>
                            <span class="stat-value">{{ riskSummary?.sourceMapLeakCount || 0 }}</span>
                        </div>
                    </div>

                    <div class="risk-breakdown">
                        <span class="risk-tag critical">{{ riskSummary?.criticalCount || 0 }} 严重</span>
                        <span class="risk-tag high">{{ riskSummary?.highCount || 0 }} 高危</span>
                        <span class="risk-tag medium">{{ riskSummary?.mediumCount || 0 }} 中危</span>
                        <span class="risk-tag low">{{ riskSummary?.lowCount || 0 }} 低危</span>
                    </div>
                </div>

                <div v-if="sortedSensitiveApis.length > 0" class="security-section">
                    <div class="section-title">
                        敏感 API ({{ sortedSensitiveApis.length }})
                    </div>
                    <div class="api-list">
                        <div
                            v-for="(api, index) in sortedSensitiveApis"
                            :key="index"
                            class="api-item"
                            :class="'risk-' + api.riskLevel"
                            :title="api.description"
                        >
                            <span class="risk-icon">{{ riskIconMap[api.riskLevel] }}</span>
                            <span class="api-item-text">
                                <span class="url-path">{{ api.path }}</span>
                                <span class="api-meta">[{{ api.category }}] {{ api.matchedKeyword }}</span>
                            </span>
                            <span class="api-source-badge" :class="api.source">{{ api.source === 'live' ? '已调用' : '静态' }}</span>
                        </div>
                    </div>
                </div>

                <div v-if="sortedUnauthorizedRoutes.length > 0" class="security-section">
                    <div class="section-title">
                        未授权路由 ({{ sortedUnauthorizedRoutes.length }})
                    </div>
                    <div class="api-list">
                        <div
                            v-for="(route, index) in sortedUnauthorizedRoutes"
                            :key="index"
                            class="api-item"
                            :class="'risk-' + route.riskLevel"
                            :title="route.riskDescription"
                        >
                            <span class="risk-icon">{{ riskIconMap[route.riskLevel] }}</span>
                            <span class="api-item-text">
                                <span class="url-path">{{ route.path }}</span>
                                <span class="api-meta">{{ route.riskDescription }}</span>
                            </span>
                        </div>
                    </div>
                </div>

                <div v-if="auditReport.recommendations.length > 0" class="security-section">
                    <div class="section-title">安全建议</div>
                    <div class="recommendations-list">
                        <div v-for="(rec, index) in auditReport.recommendations" :key="index" class="recommendation-item">
                            {{ rec }}
                        </div>
                    </div>
                </div>

                <div class="copy-actions">
                    <button class="secondary-btn" title="导出完整报告（含梭哈模式、路由分析、API提取、安全审计）" @click="exportMarkdown">{{ exportButtonText }}</button>
                    <button class="secondary-btn" title="复制完整报告到剪贴板" @click="copyReport">{{ copyReportText }}</button>
                </div>
            </template>

            <div v-else class="status-item info">
                点击「开始审计」进行安全分析
            </div>
        </div>
    </div>
</template>

<style scoped>
.security-panel {
    padding: 8px 0;
}

.security-summary {
    background: var(--gray-50);
    border-radius: 6px;
    padding: 12px;
    margin-bottom: 16px;
}

.summary-header {
    margin-bottom: 12px;
}

.risk-badge {
    display: inline-block;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 13px;
    font-weight: 600;
}

.risk-critical {
    background: #fee2e2;
    color: #dc2626;
}

.risk-high {
    background: #ffedd5;
    color: #ea580c;
}

.risk-medium {
    background: #fef3c7;
    color: #d97706;
}

.risk-low {
    background: #dcfce7;
    color: #16a34a;
}

.risk-safe {
    background: #f0fdf4;
    color: #15803d;
}

.summary-stats {
    display: flex;
    gap: 16px;
    margin-bottom: 12px;
}

.stat-item {
    flex: 1;
    text-align: center;
}

.stat-label {
    display: block;
    font-size: 12px;
    color: var(--gray-500);
    margin-bottom: 4px;
}

.stat-value {
    display: block;
    font-size: 20px;
    font-weight: 700;
    color: var(--gray-900);
}

.risk-breakdown {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
}

.risk-tag {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
}

.risk-tag.critical {
    background: #fee2e2;
    color: #dc2626;
}

.risk-tag.high {
    background: #ffedd5;
    color: #ea580c;
}

.risk-tag.medium {
    background: #fef3c7;
    color: #d97706;
}

.risk-tag.low {
    background: #dcfce7;
    color: #16a34a;
}

.security-section {
    margin-bottom: 16px;
}

.section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--gray-700);
    margin-bottom: 8px;
}

.api-item.risk-critical {
    border-left: 3px solid #dc2626;
    background: #fef2f2;
}

.api-item.risk-high {
    border-left: 3px solid #ea580c;
    background: #fff7ed;
}

.api-item.risk-medium {
    border-left: 3px solid #d97706;
    background: #fffbeb;
}

.api-item.risk-low {
    border-left: 3px solid #16a34a;
    background: #f0fdf4;
}

.risk-icon {
    font-size: 14px;
    margin-right: 4px;
}

.api-meta {
    display: block;
    font-size: 11px;
    color: var(--gray-500);
    margin-top: 2px;
}

.api-source-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 500;
}

.api-source-badge.live {
    background: #dbeafe;
    color: #2563eb;
}

.api-source-badge.static {
    background: #f3f4f6;
    color: #6b7280;
}

.recommendations-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.recommendation-item {
    padding: 8px 12px;
    background: var(--gray-50);
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.5;
    color: var(--gray-700);
}
</style>