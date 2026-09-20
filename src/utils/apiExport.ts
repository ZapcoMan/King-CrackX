/**
 * API 提取结果的收集、导出文本生成与文件下载。
 *
 * 导出格式（分隔符、字段顺序、空行数量）与原 popup.js 逐字符保持一致 ——
 * 使用者可能已经把导出的 TXT 接入了自己的脚本，格式不能变。
 */

/** 收集所有端点（已调用 + 静态提取），返回原始形态 */
export function collectAllApiPaths(result: ApiExtractResult | null): string[] {
    const paths: string[] = [];
    if (!result) {
        return paths;
    }

    (result.liveApis || []).forEach(item => paths.push(item.url || item.path));
    (result.staticApis || []).forEach(item => paths.push(item.path));
    return paths;
}

/**
 * 全部端点的完整 URL（含已调用），去重。
 * 结果可直接粘贴到 Burp Suite 的 Intruder / Scanner。
 */
export function collectAllApiFullUrls(result: ApiExtractResult | null): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();
    if (!result) {
        return urls;
    }

    function push(u: string | undefined): void {
        if (!u || seen.has(u)) return;
        seen.add(u);
        urls.push(u);
    }

    (result.liveApis || []).forEach(item => push(item.url || item.path));
    (result.staticApis || []).forEach(item => push(item.fullUrl || item.path));
    return urls;
}

/** 仅 JS 中存在、但页面从未调用过的端点（未授权测试的优先目标） */
export function collectUncalledApiUrls(result: ApiExtractResult | null): string[] {
    if (!result) {
        return [];
    }

    return (result.staticApis || [])
        .filter(item => !item.called)
        .map(item => item.fullUrl || item.path);
}

/** 生成导出的 TXT 全文 */
export function buildApiExportText(result: ApiExtractResult | null): string {
    if (!result) {
        return '';
    }

    const liveApis = result.liveApis || [];
    const staticApis = result.staticApis || [];
    const uncalled = staticApis.filter(item => !item.called);
    const lines: string[] = [];

    lines.push('# King-Crack API 导出');
    lines.push('# 页面: ' + (result.pageUrl || ''));
    lines.push('# 时间: ' + new Date(result.extractedAt || Date.now()).toLocaleString());
    lines.push('');

    lines.push('## 实际调用接口 (' + liveApis.length + ' 条)');
    liveApis.forEach(item => lines.push(item.url || item.path));
    lines.push('');

    lines.push('## JS静态提取接口 (' + staticApis.length + ' 条，未调用 ' + uncalled.length + ' 条)');
    staticApis.forEach(item => {
        const status = item.called ? '[已调用]' : '[未调用]';
        const sources = (item.sources && item.sources.length) ? ' 来源:' + item.sources.join(',') : '';
        lines.push((item.fullUrl || item.path) + '\t' + status + sources);
    });
    lines.push('');

    lines.push('## 未调用端点清单 (Burp优先测试目标)');
    uncalled.forEach(item => lines.push(item.fullUrl || item.path));
    lines.push('');

    if (result.sourceMaps && result.sourceMaps.length) {
        lines.push('## Sourcemap 泄露');
        result.sourceMaps.forEach(map => lines.push(map.mapUrl));
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * 生成导出文件名：vuecrack-api-<host>-<yyyyMMdd-HHmmss>.txt
 * 主机名取不到时退化为 site。
 */
export function buildApiExportFilename(currentTabUrl: string): string {
    let host = 'site';
    try {
        host = new URL(currentTabUrl).hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    } catch (error) {
        // 标签页 URL 非法（如 chrome:// 页面）时使用默认名
    }

    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `vuecrack-api-${host}-${stamp}.txt`;
}

/** 触发浏览器下载（由 a[download] 完成，不需要额外权限） */
export function downloadTextFile(filename: string, text: string): void {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 把文本写入剪贴板，返回是否成功 */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (error) {
        return false;
    }
}
