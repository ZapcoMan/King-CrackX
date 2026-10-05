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
                                <span class="api-item-meta">[{{ api.category }}] {{ api.matchedKeyword }}</span>
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
                                <span class="api-item-meta">{{ route.riskDescription }}</span>
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