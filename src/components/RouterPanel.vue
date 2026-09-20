<script setup lang="ts">
/**
 * 路由分析面板。
 *
 * 按 panelState 渲染五种状态，其中 ready 状态下再交给 UrlList 渲染 URL 列表。
 * 原实现是往 #routerAnalysisContainer / #pathListContainer 里塞 innerHTML，
 * 这里改成声明式渲染，避免手写字符串拼接带来的转义与一致性风险。
 */

import { useRouterAnalysis } from '../composables/useRouterAnalysis';
import UrlList from './UrlList.vue';

const {
    panelState,
    panelMessage,
    vueVersionText,
    routeListState
} = useRouterAnalysis();
</script>

<template>
    <div>
        <div v-if="panelState === 'loading'" class="status-item info">
            <span class="loading-spinner"></span>
            {{ panelMessage }}
        </div>

        <div v-else-if="panelState === 'error'" class="status-item error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="#d32f2f" stroke-width="2"/>
                <path d="M15 9L9 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
                <path d="M9 9L15 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
            </svg>
            {{ panelMessage }}
        </div>

        <div v-else-if="panelState === 'no-vue'" class="status-item error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="#d32f2f" stroke-width="2"/>
                <path d="M15 9L9 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
                <path d="M9 9L15 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
            </svg>
            未检测到Vue
        </div>

        <div v-else-if="panelState === 'no-router'" class="status-item error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z" stroke="#d32f2f" stroke-width="2"/>
                <path d="M15 9L9 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
                <path d="M9 9L15 15" stroke="#d32f2f" stroke-width="2" stroke-linecap="round"/>
            </svg>
            未检测到Vue Router
        </div>

        <template v-else-if="panelState === 'ready'">
            <h3>当前Vue版本： <span class="version-badge">{{ vueVersionText }}</span></h3>
            <UrlList :state="routeListState" />
        </template>
    </div>
</template>
