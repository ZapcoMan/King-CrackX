/**
 * King-CrackX —— Service Worker（后台脚本）
 *
 * 职责：管理「梭哈模式」动态内容脚本的注册与注销。
 * 「梭哈模式」需要在 document_start 阶段以 MAIN world 注入，
 * 且只对用户开启过的站点生效，因此无法写死在 manifest 中，
 * 必须由本文件通过 chrome.scripting 按白名单动态注册。
 */
(function () {
    /** 旧版本的全局开关 key（已废弃，仅在同步时重置为 false 以做兼容清理） */
    const LEGACY_ALL_IN_STORAGE_KEY = 'vuecrack_all_in_enabled';
    /** 当前使用的站点白名单存储 key，结构为 { "example.com": true } */
    const ALL_IN_SITES_STORAGE_KEY = 'vuecrack_all_in_sites';
    /** 动态内容脚本的固定 id，用于注册/查询/注销 */
    const ALL_IN_SCRIPT_ID = 'vuecrack-all-in-script';

    /** 同步任务的串行队列尾指针，保证注册/注销操作依次执行 */
    let syncQueue: Promise<void> = Promise.resolve();

    /**
     * 清洗「梭哈模式」站点表，只保留值严格为 true 的合法 hostname 条目。
     *
     * 存储中的数据可能因旧版本、手工修改或异常写入而包含：
     *   - 非对象结构（null / 数组 / 字符串）
     *   - 值不是 true 的无效条目
     *   - key 不是合法 hostname（如带路径、带通配符）
     * 这里统一归一化，避免后续生成 match pattern 时产生非法参数。
     *
     * @param value - 从 chrome.storage.local 读出的原始值，结构不可信
     * @returns 归一化后的白名单，形如 { "example.com": true }
     */
    function normalizeAllInSites(value: unknown): Record<string, true> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }

        const source = value as Record<string, unknown>;

        return Object.keys(source).reduce<Record<string, true>>((accumulator, key) => {
            const normalizedKey = normalizeSiteKey(key);
            if (normalizedKey && source[key] === true) {
                accumulator[normalizedKey] = true;
            }
            return accumulator;
        }, {});
    }

    /**
     * 把任意形式的站点标识归一化成一个纯 hostname（小写）。
     *
     * 支持的输入：
     *   - 完整 URL，如 "https://Example.com/path" -> "example.com"
     *   - 已经是 hostname，如 "Example.com"        -> "example.com"
     * 不合法（含 / # ? * 等字符、或 URL 解析失败）时返回空字符串，
     * 由调用方通过 falsy 判断过滤掉。
     *
     * @param siteKey - 待归一化的站点标识
     * @returns 小写 hostname；不合法时为空字符串
     */
    function normalizeSiteKey(siteKey: unknown): string {
        if (!siteKey || typeof siteKey !== 'string') {
            return '';
        }

        const trimmed = siteKey.trim().toLowerCase();
        if (!trimmed) {
            return '';
        }

        try {
            if (/^https?:\/\//i.test(trimmed)) {
                const parsed = new URL(trimmed);
                return parsed.hostname.toLowerCase();
            }
        } catch (error) {
            return '';
        }

        // hostname 中不允许出现这些字符，出现即视为非法输入
        if (trimmed.includes('/') || trimmed.includes('#') || trimmed.includes('?') || trimmed.includes('*')) {
            return '';
        }

        return trimmed;
    }

    /**
     * 把 hostname 转换为 chrome.scripting 可用的 match pattern。
     * 例如 "example.com" -> "*://example.com/*"（同时覆盖 http 与 https）。
     *
     * @param siteKey - 站点标识，内部会先做归一化
     * @returns match pattern；输入不合法时为空字符串
     */
    function toMatchPattern(siteKey: string): string {
        const normalizedKey = normalizeSiteKey(siteKey);
        if (!normalizedKey) {
            return '';
        }

        return `*://${normalizedKey}/*`;
    }

    /**
     * 查询当前是否已注册「梭哈模式」动态内容脚本。
     *
     * 使用 getRegisteredContentScripts 而非内部变量记录状态，
     * 是因为 Service Worker 随时可能被浏览器回收重启，内存状态不可靠，
     * 必须每次以 Chrome 的真实注册表为准。
     *
     * @returns 已注册的脚本对象；未注册时为 null
     */
    async function getRegisteredAllInScript(): Promise<chrome.scripting.RegisteredContentScript | null> {
        const scripts = await chrome.scripting.getRegisteredContentScripts({
            ids: [ALL_IN_SCRIPT_ID]
        });
        return scripts[0] || null;
    }

    /**
     * 注销「梭哈模式」动态内容脚本。
     * 先查询再注销，避免对未注册的 id 调用注销接口而抛错。
     */
    async function unregisterAllInScript(): Promise<void> {
        if (!(await getRegisteredAllInScript())) {
            return;
        }

        await chrome.scripting.unregisterContentScripts({
            ids: [ALL_IN_SCRIPT_ID]
        });
    }

    /**
     * 注册「梭哈模式」动态内容脚本。
     *
     * 关键配置说明：
     *   - runAt: 'document_start' —— 必须在页面框架代码执行前注入，
     *     才能抢在业务注册路由守卫之前完成接管。
     *   - world: 'MAIN' —— 需运行在页面主世界，才能访问 Vue 内部对象。
     *   - allFrames: true —— iframe 中的 Vue 应用同样需要接管。
     *
     * @param matches - match pattern 列表，为空时直接返回不注册
     */
    async function registerAllInScript(matches: string[]): Promise<void> {
        if (!matches.length) {
            return;
        }

        await chrome.scripting.registerContentScripts([{
            id: ALL_IN_SCRIPT_ID,
            js: ['all-in.js'],
            matches,
            runAt: 'document_start',
            world: 'MAIN',
            allFrames: true
        }]);
    }

    /**
     * 依据存储中的站点白名单，同步「梭哈模式」脚本的注册状态。
     *
     * 采用「先全部注销，再按需注册」的幂等策略：
     * Chrome 的 registerContentScripts 对已存在的 id 会报错，
     * 因此每次变更都整体重建，避免增量更新带来的状态不一致。
     * 末尾会把旧版本的全局开关键重置为 false，仅作兼容清理。
     */
    async function syncAllInScript(): Promise<void> {
        const result = await chrome.storage.local.get([ALL_IN_SITES_STORAGE_KEY]);
        const sites = normalizeAllInSites(result[ALL_IN_SITES_STORAGE_KEY]);
        const matches = Object.keys(sites)
            .map(toMatchPattern)
            .filter(Boolean)
            .sort();

        await unregisterAllInScript();

        if (matches.length) {
            await registerAllInScript(matches);
        }

        await chrome.storage.local.set({
            [LEGACY_ALL_IN_STORAGE_KEY]: false
        });
    }

    /**
     * 把同步任务串行化排队执行。
     *
     * 多个触发源（安装、启动、存储变更、popup 消息）可能几乎同时要求同步，
     * 而注册/注销是异步且有依赖关系的操作，并发执行会互相干扰。
     * 这里用 Promise 链把任务排成队列：前一个无论成功失败都继续执行下一个，
     * 保证任意时刻只有一个同步流程在跑。
     *
     * @returns 当前队列尾部的 Promise，可用于等待本轮同步结束
     */
    function queueSyncAllInScript(): Promise<void> {
        syncQueue = syncQueue
            .catch(() => {})
            .then(syncAllInScript);
        return syncQueue;
    }

    // ===== 触发时机：Service Worker 每次被唤醒时 =====
    // Service Worker 会被浏览器回收，重启后内存状态丢失，
    // 但动态内容脚本的注册是持久化的，因此需要在每次加载时对齐一次状态。
    queueSyncAllInScript().catch(error => {
        console.warn('[VueCrack] Failed to sync all-in script on service worker load:', error);
    });

    // ===== 触发时机：扩展安装 / 更新 =====
    chrome.runtime.onInstalled.addListener(() => {
        queueSyncAllInScript().catch(error => {
            console.warn('[VueCrack] Failed to sync all-in script on install:', error);
        });
    });

    // ===== 触发时机：浏览器启动 =====
    // 浏览器重启后需要确认动态注册仍然有效。
    chrome.runtime.onStartup.addListener(() => {
        queueSyncAllInScript().catch(error => {
            console.warn('[VueCrack] Failed to sync all-in script on startup:', error);
        });
    });

    // ===== 触发时机：站点白名单发生变化 =====
    // popup 中切换开关会写入 storage，此处监听并同步注册状态。
    // 只关心 local 区且只关心白名单 key 的变更，其他变更直接忽略。
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, ALL_IN_SITES_STORAGE_KEY)) {
            return;
        }

        queueSyncAllInScript().catch(error => {
            console.warn('[VueCrack] Failed to sync all-in script after storage change:', error);
        });
    });

    // ===== 触发时机：收到 popup 的主动同步请求 =====
    // popup 写入 storage 后主动发消息请求同步，确保立即生效。
    // 返回 true 表示将异步调用 sendResponse，需保持消息通道开放。
    chrome.runtime.onMessage.addListener((message: { action?: string } | undefined, _sender, sendResponse) => {
        if (message?.action !== 'syncAllInMode') {
            return false;
        }

        queueSyncAllInScript()
            .then(() => sendResponse({ ok: true }))
            .catch((error: unknown) => sendResponse({
                ok: false,
                error: error instanceof Error ? error.message : String(error)
            }));

        return true;
    });
})();
