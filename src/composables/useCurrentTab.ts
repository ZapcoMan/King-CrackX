/**
 * 当前活动标签页的信息。
 *
 * popup 同时只有一个实例，因此状态直接放在模块作用域（相当于单例 store），
 * 而不是每次调用都新建一份 —— 否则各个组件会各自持有一份互不同步的副本。
 */

import { ref } from 'vue';

/** 当前活动标签页 id；null 表示尚未取到或取不到 */
export const currentTabId = ref<number | null>(null);
/** 当前活动标签页 URL */
export const currentTabUrl = ref('');

/**
 * 查询当前活动标签页并同步到全局状态。
 *
 * @returns 查询到的标签页；失败（无权限 / 无标签页）时返回 null
 */
export function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
    return new Promise(resolve => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (chrome.runtime.lastError || !tabs || !tabs[0]) {
                resolve(null);
                return;
            }

            currentTabId.value = tabs[0].id ?? null;
            currentTabUrl.value = tabs[0].url || '';
            resolve(tabs[0]);
        });
    });
}

/** 组合式入口（状态为模块级单例，多个组件共享同一份） */
export function useCurrentTab() {
    return {
        currentTabId,
        currentTabUrl,
        queryActiveTab
    };
}
