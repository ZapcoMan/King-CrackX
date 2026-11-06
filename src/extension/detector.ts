/**
 * King-CrackX —— 前端框架检测与路由分析器（MAIN world，唯一入口）
 *
 * 由 content.js 按需注入到页面主世界，自动识别页面所用框架（Vue / React），
 * 并按命中的框架走对应的分析流程，用于：
 *   1. 检测页面是否使用 Vue 或 React，并识别版本（Vue 2 / 3；React 17 / 18 / 19）
 *   2. 定位路由实例（Vue Router / React Router），枚举全部路由（含嵌套子路由）
 *   3. 清除路由守卫、改写鉴权 meta，实现前端路由绕过（Vue；React 由 all-in.js 强接管）
 *   4. 分析页面链接，推测 Router 基础路径
 *
 * 无论命中哪个框架，回传消息类型与 Vue 版本保持一致（VUE_DETECTION_RESULT /
 * VUE_ROUTER_ANALYSIS_RESULT），仅在结果对象上多带一个 framework 字段，
 * 因此 content.js / popup 的中转与渲染逻辑无需为大改。
 *
 * 结果通过 window.postMessage 回传给 content.js 中转。
 *
 * ===== 模块拆分说明 =====
 * 本文件是 detector 的唯一构建入口（见 vite.config.ts 的 EXTENSION_SCRIPTS）：
 *   - 具体框架逻辑按 Vue / React 拆到 detector-vue.ts / detector-react.ts，
 *     框架无关的上报与清洗、页面链接分析拆到 detector-shared.ts；
 *   - 本入口只保留「框架探测分发 + 检测时序 + 主执行」这三件协调职责；
 *   - 三个模块都通过普通 ESM import 被 Rollup 内联，最终产物仍是**单个自包含
 *     IIFE `detector.js`**，注入方式、manifest、content.js 中转均与原实现一致，
 *     运行期不存在任何跨文件 import（详见 vite.config.ts 对 EXTENSION_SCRIPTS 的约束注释）。
 *
 * 行为与原内联版 detector.js 逐字保持一致：检测优先级（先 Vue 后 React）、
 * 消息时序（先报检测、再延迟 50ms 报完整分析）、延迟重试（0/300/600ms 共 3 次）均未改动。
 */

import { handleError, sendResult, sendRouterResult } from './detector-shared';
import { findVueRoot, performFullAnalysis } from './detector-vue';
import { findReactRoot, performReactAnalysis } from './detector-react';

(function () {
    // ======== 统一框架检测入口 ========

    /**
     * 统一探测页面框架：先 Vue，后 React。
     *
     * 顺序考量：Vue 的根实例集中在挂载点、探测成本低；
     * React 需要扫描 DOM 找 Fiber 标记、成本相对高，因此作为次选。
     * 微前端等同时存在两者的场景下，优先返回 Vue（与既有行为兼容）。
     *
     * @returns 命中的框架及对应元素；均未命中时为 null
     */
    function detectFramework(): { framework: FrameworkKind; vueRoot?: VueElementLike; reactRoot?: ReactElementLike } | null {
        const vueRoot = findVueRoot(document.body);
        if (vueRoot) {
            return { framework: 'vue', vueRoot };
        }

        const reactRoot = findReactRoot(document.body);
        if (reactRoot) {
            return { framework: 'react', reactRoot };
        }

        return null;
    }

    // ======== 延迟检测机制 ========

    /**
     * 依据命中的框架执行分析并回传：先报检测结果，再延迟 50ms 报完整分析。
     *
     * 抽出为函数，是为了让「立即检测」和「延迟检测重试」两条路径复用同一套逻辑，
     * 保持消息时序一致（popup 依赖这个时序把状态从 loading 推进到 ready）。
     *
     * @param hit - detectFramework 的命中结果
     * @param methodLabel - 检测方式描述，随检测结果一并上报
     */
    function analyzeAndReport(
        hit: { framework: FrameworkKind; vueRoot?: VueElementLike; reactRoot?: ReactElementLike },
        methodLabel: string
    ): void {
        sendResult({
            detected: true,
            method: methodLabel,
            framework: hit.framework
        });

        setTimeout(() => {
            const analysisResult = hit.framework === 'vue'
                ? performFullAnalysis()
                : performReactAnalysis(hit.reactRoot as ReactElementLike);
            sendRouterResult(analysisResult);
        }, 50);
    }

    /**
     * 延迟检测机制：应对框架实例延迟挂载的场景。
     *
     * 部分页面的 Vue / React 应用在首屏后才初始化（如等待接口返回、异步路由），
     * 立即检测会误判为「未使用框架」，因此按 0ms -> 300ms -> 600ms
     * 三级延迟重试，最多 3 次。
     *
     * 一旦探测到框架实例，便与立即检测路径保持一致：
     * 先上报检测结果，再延迟 50ms 执行完整分析并回传。
     *
     * @param delay - 本次延迟毫秒数
     * @param retryCount - 已重试次数，达到 3 次即放弃
     */
    function delayedDetection(delay: number = 0, retryCount: number = 0): void {
        // 改为最大重试3次
        if (retryCount >= 3) {
            sendResult({
                detected: false,
                method: 'Max retry limit reached (3 attempts)'
            });
            return;
        }

        setTimeout(() => {
            const hit = detectFramework();

            if (hit) {
                // 延迟挂载场景下找到实例：与立即检测路径保持一致
                analyzeAndReport(hit, `Delayed detection (${delay}ms)`);
            } else if (delay === 0) {
                delayedDetection(300, retryCount + 1);    // 第1次重试：300ms
            } else if (delay === 300) {
                delayedDetection(600, retryCount + 1);    // 第2次重试：600ms
            } else {
                sendResult({
                    detected: false,
                    method: `All delayed detection failed (${retryCount + 1} attempts)`
                });
            }
        }, delay);
    }

    // ======== 主执行逻辑 ========
    // 脚本注入后立即尝试检测：
    //   - 命中框架实例（Vue 或 React）：先上报检测结果，再延迟 50ms 执行完整分析
    //     （留出时间让框架完成内部初始化，避免读取到不完整的路由表）
    //   - 未命中：转入延迟检测流程，按 0/300/600ms 重试
    //   - 抛出异常：记录后直接以 500ms 延迟重试
    try {
        const hit = detectFramework();

        if (hit) {
            analyzeAndReport(hit, 'Immediate detection');
        } else {
            delayedDetection(0, 0); // 添加初始重试计数
        }
    } catch (error) {
        handleError(error, 'Main execution', false);
        delayedDetection(500, 0); // 添加初始重试计数
    }
})();
