<script setup lang="ts">
/**
 * API 端点提取面板。
 *
 * 展示结构与原实现逐块对应：
 *   进度条 → 错误 → 「实际调用API」列表 → 「JS源码静态提取」列表
 *          → Sourcemap 泄露告警 → 统计信息 → 三个操作按钮
 *
 * 所有按钮的「文案临时切换」都用本地 ref + setTimeout 复位实现，
 * 与原来直接改 this.textContent 的效果一致（含 2s / 1.5s 的复位时长）。
 */

import { computed, ref } from 'vue';
import { useApiExtract } from '../composables/useApiExtract';
import { splitUrlForDisplay } from '../utils/url';
import { copyText } from '../utils/apiExport';

const {
    apiExtractResult,
    apiProgress,
    apiError,
    apiStats,
    extractApi,
    copyAllFullUrls,
    exportTxt,
    copyJson
} = useApiExtract();

const copyAllText = ref('复制完整URL (Burp)');
const exportButtonText = ref('导出TXT');
const copyJsonText = ref('复制JSON');
/** 单条端点的复制成功标记，键为 "live:<url>" 或 "static:<path>" */
const copiedKeys = ref<Record<string, boolean>>({});

/** 已真实发出的接口请求（拆出域名/路径便于分色展示） */
const liveItems = computed(() => {
    return (apiExtractResult.value?.liveApis || []).map(item => {
        const target = item.url || item.path;
        const parts = splitUrlForDisplay(target);
        return {
            url: target,
            domain: parts.domain,
            path: parts.path
        };
    });
});

/** JS 源码静态提取出的端点 */
const staticItems = computed(() => {
    return (apiExtractResult.value?.staticApis || []).map(item => {
        const fullUrl = item.fullUrl || item.path;
        const sourceTip = item.sources && item.sources.length
            ? `来源: ${item.sources.join(', ')}\n`
            : '';

        return {
            path: item.path,
            fullUrl,
            hasParams: item.hasParams,
            called: item.called,
            tip: `${sourceTip}完整URL: ${fullUrl}`
        };
    });
});

const sourceMaps = computed(() => apiExtractResult.value?.sourceMaps || []);

/** 单条复制按钮的文案 */
function itemCopyLabel(key: string): string {
    return copiedKeys.value[key] ? '已复制' : '复制';
}

/** 复制单条端点，成功后把文案切成「已复制」并在 1.5s 后还原 */
async function copyItem(key: string, value: string): Promise<void> {
    const ok = await copyText(value);
    if (!ok) {
        return;
    }

    copiedKeys.value = { ...copiedKeys.value, [key]: true };

    setTimeout(() => {
        const next = { ...copiedKeys.value };
        delete next[key];
        copiedKeys.value = next;
    }, 1500);
}

/** 复制全部端点完整 URL（去重） */
async function onCopyAllFullUrls(): Promise<void> {
    const count = await copyAllFullUrls();

    copyAllText.value = count >= 0 ? `已复制 ${count} 条!` : '复制失败';
    setTimeout(() => {
        copyAllText.value = '复制完整URL (Burp)';
    }, 2000);
}

/** 导出 TXT */
function onExport(): void {
    try {
        exportTxt();
        exportButtonText.value = '已导出!';
    } catch (error) {
        exportButtonText.value = '导出失败';
    }

    setTimeout(() => {
        exportButtonText.value = '导出TXT';
    }, 2000);
}

/** 复制完整 JSON */
async function onCopyJson(): Promise<void> {
    const ok = await copyJson();

    copyJsonText.value = ok ? '已复制!' : '复制失败';
    setTimeout(() => {
        copyJsonText.value = '复制JSON';
    }, 2000);
}
</script>

<template>
    <div class="api-panel">
        <div class="api-panel-header">
            <div>
                <div class="all-in-title">API 端点提取</div>
            </div>
            <button class="secondary-btn" @click="extractApi">提取API</button>
        </div>

        <div>
            <div v-if="apiProgress" class="status-item info">
                <span class="loading-spinner"></span>
                {{ apiProgress }}
            </div>

            <div v-else-if="apiError" class="status-item error">API提取失败: {{ apiError }}</div>

            <template v-else-if="apiExtractResult">
                <div class="api-section-title">实际调用API（页面已发出请求）：{{ apiStats.liveCount }} 条</div>
                <div class="api-list">
                    <template v-if="liveItems.length">
                        <div
                            v-for="(item, index) in liveItems"
                            :key="index"
                            class="api-item"
                            :title="item.url"
                        >
                            <span class="api-item-text"><span class="url-domain">{{ item.domain }}</span><span class="url-path">{{ item.path }}</span></span>
                            <button class="api-copy-item-btn" @click="copyItem('live:' + index, item.url)">{{ itemCopyLabel('live:' + index) }}</button>
                        </div>
                    </template>
                    <div v-else class="api-item"><span class="api-item-text" style="color:var(--gray-500)">暂无（操作一下页面再重新提取可捕获真实请求）</span></div>
                </div>

                <div class="api-section-title">JS源码静态提取：{{ apiStats.staticCount }} 条（未调用 {{ apiStats.uncalledCount }} 条 = 优先测试目标）</div>
                <div class="api-list">
                    <template v-if="staticItems.length">
                        <div
                            v-for="(item, index) in staticItems"
                            :key="item.path"
                            class="api-item"
                            :class="{ uncalled: !item.called }"
                            :title="item.tip"
                        >
                            <span class="api-item-text">{{ item.path }}</span>
                            <span v-if="item.hasParams" class="api-param-badge">参数</span>
                            <span v-if="item.called" class="api-called-badge">已调用</span>
                            <button class="api-copy-item-btn" @click="copyItem('static:' + index, item.fullUrl)">{{ itemCopyLabel('static:' + index) }}</button>
                        </div>
                    </template>
                    <div v-else class="api-item"><span class="api-item-text" style="color:var(--gray-500)">未提取到端点</span></div>
                </div>

                <div v-if="sourceMaps.length" class="sourcemap-warn">
                    ⚠ Sourcemap 泄露 {{ sourceMaps.length }} 个（可还原源码）：<br>
                    <template v-for="map in sourceMaps" :key="map.mapUrl">{{ map.mapUrl }}<br></template>
                </div>

                <div class="api-meta">扫描JS {{ apiStats.scriptCount }} 个 · 内联 {{ apiStats.inlineScriptCount }} 段<template v-if="apiStats.failedCount"> · 失败 {{ apiStats.failedCount }} 个（跨域受限）</template></div>

                <div class="copy-actions api-copy-actions">
                    <button class="secondary-btn" title="全部端点完整URL(已去重)" @click="onCopyAllFullUrls">{{ copyAllText }}</button>
                    <button class="secondary-btn" title="导出TXT文件（含完整URL、调用状态、来源、未调用清单）" @click="onExport">{{ exportButtonText }}</button>
                    <button class="secondary-btn" @click="onCopyJson">{{ copyJsonText }}</button>
                </div>
            </template>
        </div>
    </div>
</template>
