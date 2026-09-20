/**
 * 少量 DOM 辅助函数（Vue 模板无法直接表达的那些）。
 */

/**
 * 让「当前路由」那一项滚动进可视区域。
 *
 * 只有当它已经跑出可视范围时才滚动（上下各留出安全边距），
 * 避免每次渲染都强制滚动、打断用户正在浏览的位置。
 *
 * @param activeItem - 被标记为 current-route 的元素；不存在时直接返回
 */
export function ensureActiveRouteVisible(activeItem: Element | null): void {
    if (!activeItem) {
        return;
    }

    const rect = activeItem.getBoundingClientRect();
    const topSafeMargin = 12;
    const bottomSafeMargin = 16;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

    const isAboveViewport = rect.top < topSafeMargin;
    const isBelowViewport = rect.bottom > (viewportHeight - bottomSafeMargin);

    if (!isAboveViewport && !isBelowViewport) {
        return;
    }

    activeItem.scrollIntoView({
        behavior: 'auto',
        block: 'nearest',
        inline: 'nearest'
    });
}
