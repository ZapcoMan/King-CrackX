<script setup lang="ts">
/**
 * 梭哈模式面板：标题 + 状态行 + 站点级开关。
 *
 * 开关是「按 hostname」生效的，因此在不支持的页面（chrome:// 等）上会被禁用。
 */

import { useAllInMode } from '../composables/useAllInMode';

const {
    allInEnabled,
    allInSupported,
    allInStatusText,
    setAllInEnabled
} = useAllInMode();

/**
 * 处理开关变化。
 *
 * 为什么这里要手动回写 target.checked：
 *   当页面不支持梭哈模式时状态不会变化（仍为 false），
 *   Vue 就不会重新渲染，DOM 上的勾选状态会与真实状态不一致。
 *   原实现里也是显式把 checked 置回 false。
 */
function onToggle(event: Event): void {
    const target = event.target as HTMLInputElement;

    if (!allInSupported.value) {
        target.checked = false;
        return;
    }

    void setAllInEnabled(target.checked);
}
</script>

<template>
    <div class="all-in-panel">
        <div>
            <div class="all-in-title">梭哈模式</div>
            <div class="all-in-status">{{ allInStatusText }}</div>
        </div>
        <label class="switch" title="刷新页面后生效">
            <input
                type="checkbox"
                :checked="allInEnabled"
                :disabled="!allInSupported"
                @change="onToggle"
            >
            <span class="switch-slider"></span>
        </label>
    </div>
</template>
