<script setup lang="ts">
/**
 * 完整 URL 列表（对应原 displayUrlList 的渲染部分）。
 *
 * 有三态：
 *   empty —— 分析成功但没有可用路由（或数据结构异常）
 *   error —— URL 拼接过程抛错（典型情况：标签页 URL 非法）
 *   ready —— 正常渲染列表
 *
 * 「复制所有URL」取的是界面上显示的域名+路径文本（与原实现取 .url-text 的
 * textContent 完全一致），不是直接取原始 url 字段。
 */

import { computed, nextTick, ref, watch } from 'vue';
import type { RouteListState } from '../composables/useRouterAnalysis';
import { useRouterAnalysis } from '../composables/useRouterAnalysis';
import { splitUrlForDisplay } from '../utils/url';
import { ensureActiveRouteVisible } from '../utils/dom';
import { copyText } from '../utils/apiExport';

const props = defineProps<{ state: RouteListState }>();

const { setUrlMode, navigateTo, isCurrentRoute } = useRouterAnalysis();

const listEl = ref<HTMLElement | null>(null);
const copyAllText = ref('复制所有URL');
/** 每条 URL 的复制结果，用于把按钮文案临时改成「已复制!」或「失败」 */
const copyStateByUrl = ref<Record<string, 'ok' | 'fail'>>({});

/** 预计算展示项：域名/路径拆分、是否当前路由 */
const displayItems = computed(() => {
    if (props.state.kind !== 'ready') {
        return [];
    }

    return props.state.list.items.map(item => {
        const parts = splitUrlForDisplay(item.url);
        return {
            url: item.url,
            domain: parts.domain,
            path: parts.path,
            current: isCurrentRoute(item.url)
        };
    });
});

/** 按钮文案：默认「复制」，复制成功/失败后临时切换 */
function copyLabel(url: string): string {
    const state = copyStateByUrl.value[url];
    if (state === 'ok') return '已复制!';
    if (state === 'fail') return '失败';
    return '复制';
}

async function copyUrl(url: string): Promise<void> {
    const ok = await copyText(url);
    copyStateByUrl.value = { ...copyStateByUrl.value, [url]: ok ? 'ok' : 'fail' };

    setTimeout(() => {
        const next = { ...copyStateByUrl.value };
        delete next[url];
        copyStateByUrl.value = next;
    }, 2000);
}

async function copyAll(): Promise<void> {
    const text = displayItems.value.map(item => (item.domain || '') + item.path).join('\n');
    const ok = await copyText(text);

    copyAllText.value = ok ? '已复制!' : '复制失败';
    setTimeout(() => {
        copyAllText.value = '复制所有URL';
    }, 2000);
}

/**
 * 列表渲染完成后，把「当前路由」滚进可视区。
 * 延迟 100ms 与原实现一致 —— 让浏览器先完成一次布局，否则量到的位置是旧的。
 */
watch(() => props.state, async () => {
    await nextTick();

    setTimeout(() => {
        const activeItem = listEl.value
            ? listEl.value.querySelector('.full-url-item.current-route')
            : null;
        ensureActiveRouteVisible(activeItem);
    }, 100);
});
</script>

<template>
    <p v-if="state.kind === 'empty'">{{ state.message }}</p>

    <div v-else-if="state.kind === 'error'" class="status-item error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="#d32f2f" stroke-width="2"/>
            <path d="M15 9L9 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
            <path d="M9 9L15 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
        </svg>
        {{ state.message }}
    </div>

    <template v-else-if="state.kind === 'ready'">
        <h3>
            <span>完整URL列表</span>
            <span class="route-count-badge">{{ displayItems.length }} 条路由</span>
        </h3>

        <div v-if="state.list.canUseBaseMode" class="path-mode-selector" role="group" aria-label="URL 生成模式">
            <button
                type="button"
                class="path-mode-btn"
                :class="{ active: state.list.mode === 'standard' }"
                @click="setUrlMode(state.list.modeKey, 'standard')"
            >标准</button>
            <button
                type="button"
                class="path-mode-btn"
                :class="{ active: state.list.mode === 'base' }"
                :title="state.list.baseModeLabel"
                @click="setUrlMode(state.list.modeKey, 'base')"
            >{{ state.list.baseModeLabel }}</button>
        </div>

        <div class="url-section">
            <div class="url-section-header">
                <span>{{ state.list.sectionTitle }}</span>
            </div>
            <div ref="listEl" class="full-urls-list displayed-urls">
                <div
                    v-for="item in displayItems"
                    :key="item.url"
                    class="full-url-item"
                    :class="{ 'current-route': item.current }"
                >
                    <div class="url-main" :title="item.url">
                        <span class="url-text"><span v-if="item.domain" class="url-domain">{{ item.domain }}</span><span class="url-path">{{ item.path }}</span></span>
                        <span class="route-status-slot">
                            <span v-if="item.current" class="route-status-badge current">当前</span>
                        </span>
                    </div>
                    <div class="route-actions">
                        <button class="url-copy-btn" @click="copyUrl(item.url)">{{ copyLabel(item.url) }}</button>
                        <button class="url-open-btn" @click="navigateTo(item.url)">打开</button>
                    </div>
                </div>
            </div>
        </div>

        <div class="copy-actions">
            <button class="secondary-btn" @click="copyAll">{{ copyAllText }}</button>
        </div>
    </template>
</template>
