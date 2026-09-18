/**
 * King-CrackX —— 内容脚本（ISOLATED world）
 *
 * 职责：作为扩展与页面之间的消息桥接层。
 *
 * 为什么需要它：
 *   detector.js / all-in.js / api-extractor.js 必须运行在页面的 MAIN world
 *   才能访问 Vue 内部对象，但 MAIN world 无法直接使用 chrome.* API。
 *   因此由本脚本在 ISOLATED world 中完成两侧转发：
 *     页面脚本 --window.postMessage--> 本脚本 --chrome.runtime.sendMessage--> popup
 *     popup --chrome.runtime.sendMessage--> 本脚本 --注入 script--> 页面脚本
 */

// 缓存的 Vue 检测结果，供 popup 复用，避免重复分析
let detectionResult = {
    detected: false,
    method: '',
    details: {},
    errorMsg: ''
};

// 缓存的路由分析结果，供 popup 复用
let routerAnalysisResult = null;

// 防止同一页面重复注入 detector.js（注入未完成期间再次请求会直接返回）
let detectorInjectionInProgress = false;

/**
 * 向页面注入 detector.js（MAIN world）以执行 Vue 检测与路由分析。
 *
 * 通过动态创建 <script> 并指向 web_accessible_resources 中的文件实现注入，
 * 脚本加载后立即移除 DOM 节点，避免污染页面结构。
 * 使用 detectorInjectionInProgress 做并发保护：分析未结束前重复调用会被忽略。
 *
 * @returns {boolean} true 表示已发起注入；false 表示被并发保护拦截或注入失败
 */
function injectDetector() {
    if (detectorInjectionInProgress) {
        return false;
    }

    try {
        detectorInjectionInProgress = true;
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('detector.js');
        // 加载成功后移除节点；注入是否成功由页面脚本回传的消息判定
        script.onload = function() {
            this.remove();
        };
        script.onerror = function() {
            detectorInjectionInProgress = false;
            this.remove();
        };
        (document.head || document.documentElement).appendChild(script);
        return true;
    } catch (e) {
        detectorInjectionInProgress = false;
        console.error("Failed to inject detector script:", e);
        detectionResult.errorMsg = e.toString();
        chrome.runtime.sendMessage({
            action: "vueDetectionError",
            error: e.toString()
        });
        return false;
    }
}

/**
 * 向页面注入 api-extractor.js（MAIN world）以提取 API 端点。
 *
 * 与 detector.js 不同，本脚本支持重复提取（每次点击"提取API"都应重新扫描），
 * 因此 URL 后拼接时间戳参数绕过浏览器缓存，确保每次都执行最新的脚本内容。
 *
 * @returns {boolean} true 表示已发起注入；false 表示注入失败
 */
function injectApiExtractor() {
    try {
        const script = document.createElement('script');
        // 附加时间戳参数，强制绕过缓存以支持重复提取
        script.src = chrome.runtime.getURL('api-extractor.js') + '?t=' + Date.now();
        script.onload = function() {
            this.remove();
        };
        script.onerror = function() {
            this.remove();
            chrome.runtime.sendMessage({
                action: "vuecrackApiError",
                error: "api-extractor.js 注入失败"
            });
        };
        (document.head || document.documentElement).appendChild(script);
        return true;
    } catch (e) {
        console.error("Failed to inject api extractor:", e);
        chrome.runtime.sendMessage({
            action: "vuecrackApiError",
            error: e.toString()
        });
        return false;
    }
}

/**
 * 监听页面脚本通过 window.postMessage 回传的消息，并转发给 popup。
 *
 * 消息分三类：
 *   1. Vue 检测 / 路由分析结果（来自 detector.js）—— 同时更新本地缓存
 *   2. 梭哈模式运行状态（来自 all-in.js）
 *   3. API 提取进度 / 结果 / 错误（来自 api-extractor.js）
 *
 * 安全校验：只处理 event.source === window 的消息，排除其他窗口/iframe 的干扰；
 * 对第三方来源的消息额外校验 event.data.source 字段，避免误转发。
 */
window.addEventListener('message', function(event) {
    // 只接受来自当前页面主世界的消息
    if (event.source !== window) return;

    try {
        // ---- 类型 1：Vue 检测结果 ----
        if (event.data.type === 'VUE_DETECTION_RESULT') {
            detectionResult = event.data.result;
            // 未检测到 Vue 时释放注入锁，允许后续重新注入重试
            if (!detectionResult.detected) {
                detectorInjectionInProgress = false;
            }

            chrome.runtime.sendMessage({
                action: "vueDetectionResult",
                result: detectionResult
            });
        }
        // ---- 类型 1：路由分析结果 ----
        else if (event.data.type === 'VUE_ROUTER_ANALYSIS_RESULT') {
            routerAnalysisResult = event.data.result;
            // 分析流程结束，释放注入锁
            detectorInjectionInProgress = false;

            chrome.runtime.sendMessage({
                action: "vueRouterAnalysisResult",
                result: routerAnalysisResult
            });
        }
        // ---- 类型 1：路由分析出错 ----
        else if (event.data.type === 'VUE_ROUTER_ANALYSIS_ERROR') {
            detectorInjectionInProgress = false;
            chrome.runtime.sendMessage({
                action: "vueRouterAnalysisError",
                error: event.data.error
            });
        }
        // ---- 类型 2：梭哈模式状态上报 ----
        else if (event.data.type === 'VUECRACK_ALL_IN_STATUS' && event.data.source === 'vuecrack-all-in') {
            chrome.runtime.sendMessage({
                action: "vuecrackAllInStatus",
                status: event.data.status
            });
        }
        // ---- 类型 3：API 提取进度 ----
        else if (event.data.type === 'VUECRACK_API_EXTRACT_PROGRESS' && event.data.source === 'vuecrack-api-extractor') {
            chrome.runtime.sendMessage({
                action: "vuecrackApiProgress",
                message: event.data.message
            });
        }
        // ---- 类型 3：API 提取结果 ----
        else if (event.data.type === 'VUECRACK_API_EXTRACT_RESULT' && event.data.source === 'vuecrack-api-extractor') {
            chrome.runtime.sendMessage({
                action: "vuecrackApiResult",
                result: event.data.result
            });
        }
        // ---- 类型 3：API 提取出错 ----
        else if (event.data.type === 'VUECRACK_API_EXTRACT_ERROR' && event.data.source === 'vuecrack-api-extractor') {
            chrome.runtime.sendMessage({
                action: "vuecrackApiError",
                error: event.data.error
            });
        }
    } catch (e) {
        console.error("Message handling error:", e);
    }
});

/**
 * 监听来自 popup 的指令并分发处理。
 *
 * 支持的动作：
 *   - detectVue        ：执行 Vue 检测（有缓存且未强制刷新时直接返回缓存）
 *   - analyzeVueRouter ：执行路由分析（有缓存且未强制刷新时直接返回缓存）
 *   - getAllInStatus   ：向页面查询梭哈模式的实时拦截统计
 *   - extractApi       ：注入 API 提取器并开始提取
 *
 * 始终返回 true 以保持消息通道开放，允许后续异步 sendResponse。
 * （popup 不依赖返回值，结果统一通过 chrome.runtime.sendMessage 主动推送）
 */
chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    try {
        if (request.action === "detectVue") {
            // 已有检测结果且不要求强制刷新时，直接回传缓存
            if (detectionResult.detected && !request.forceRefresh) {
                chrome.runtime.sendMessage({
                    action: "vueDetectionResult",
                    result: detectionResult
                });
                sendResponse({status: "cached"});
                return true;
            }

            sendResponse({status: "detecting"});
            injectDetector();
        }
        else if (request.action === "analyzeVueRouter") {
            // 已有分析结果且不要求强制刷新时，直接回传缓存
            if (routerAnalysisResult && !request.forceRefresh) {
                chrome.runtime.sendMessage({
                    action: "vueRouterAnalysisResult",
                    result: routerAnalysisResult
                });
            } else {
                injectDetector();
            }
            sendResponse({status: "analyzing"});
        }
        else if (request.action === "getAllInStatus") {
            // 转发给 all-in.js，由页面脚本回传当前拦截统计
            window.postMessage({
                type: 'VUECRACK_GET_ALL_IN_STATUS',
                source: 'vuecrack-extension'
            }, '*');
            sendResponse({status: "requested"});
        }
        else if (request.action === "extractApi") {
            injectApiExtractor();
            sendResponse({status: "extracting"});
        }
    } catch (e) {
        console.error("Request handling error:", e);
        sendResponse({status: "error", error: e.toString()});
    }
    return true;
});
