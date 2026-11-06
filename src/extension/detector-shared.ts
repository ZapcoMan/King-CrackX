/**
 * King-CrackX —— detector 拆分：框架无关的共享基础设施
 *
 * 本文件不是独立注入脚本，而是被 detector.ts 唯一入口 import，最终与 Vue / React
 * 两个模块一起由 Rollup 打包成单个自包含 IIFE `detector.js`（见 vite.config.ts）。
 * 因此这里的跨模块函数引用在产物中会被内联为同作用域直接调用，运行时与原内联实现等价。
 *
 * 收录范围：仅「与具体框架无关、且 Vue / React 两条分析流程都会复用」的部分：
 *   - 统一结果上报（sendResult / sendRouterResult / sendError）
 *   - postMessage 结构化克隆前的数据清洗（sanitizeForPostMessage / sanitizeRouteObject）
 *   - 通用错误处理与控制台恢复（handleError / restoreConsole / ConsoleOriginals）
 *   - 页面链接分析（analyzePageLinks：Vue 与 React 都复用，故归此）
 * 各函数体逐字保留自原 detector.js，仅改为跨模块可见。
 */

/* ==================== 控制台接管 ==================== */

/** 被临时接管的控制台方法原始引用 */
export interface ConsoleOriginals {
    log: (...data: any[]) => void;
    warn: (...data: any[]) => void;
    error: (...data: any[]) => void;
    table: (tabularData?: any, properties?: string[]) => void;
}

/**
 * 统一的错误处理。
 *
 * @param error - 捕获到的错误
 * @param context - 出错位置标识，便于定位
 * @param shouldStop - 是否为致命错误。
 *        为 true 时额外向扩展上报错误并返回 false，表示应中止流程。
 * @returns true 表示可继续执行；false 表示流程中断
 */
export function handleError(error: unknown, context: string, shouldStop: boolean = false): boolean {
    const errorMsg = `${context}: ${String(error)}`;
    console.warn(errorMsg);

    if (shouldStop) {
        sendError(errorMsg);
        return false;
    }
    return true;
}

/**
 * 恢复被 performFullAnalysis 临时接管的控制台方法。
 * 必须成对调用，否则会造成 console 永久被改写。
 *
 * @param originals - 保存的原始控制台方法集合
 */
export function restoreConsole(originals: ConsoleOriginals): void {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    console.table = originals.table;
}

/* ==================== 消息发送函数 ==================== */

/**
 * 上报框架检测结果。
 * @param result - 形如 { detected: boolean, method: string, framework?: 'vue' | 'react' }
 */
export function sendResult(result: Pick<VueDetectionResult, 'detected' | 'method' | 'framework'>): void {
    window.postMessage({
        type: 'VUE_DETECTION_RESULT',
        result: result
    }, '*');
}

/**
 * 上报路由分析结果（含数据清洗与容错）。
 *
 * 关键处理：
 *   1. 归一化 allRoutes 为标准数组结构 [{name, path, meta}]
 *      —— 不同 Router 版本返回的结构不一致（数组/对象/含实例引用）
 *   2. 经 sanitizeForPostMessage 剔除函数、Promise、循环引用等
 *      无法通过 postMessage 结构化克隆的内容
 *
 * postMessage 采用结构化克隆算法，一旦数据中含不可克隆对象会直接抛错，
 * 因此这里是最后一道防线：即便清洗失败，也退化为发送最小可用结果，
 * 保证 popup 至少能拿到检测状态而不是卡在 loading。
 *
 * @param result - performFullAnalysis / performReactAnalysis 产出的原始结果
 */
export function sendRouterResult(result: RouterAnalysisResult): void {
    try {
        // 预处理 - 确保 allRoutes 是正确格式的数组
        let allRoutes: RouteEntry[] = [];
        const rawRoutes: unknown = result.allRoutes;

        if (rawRoutes) {
            if (!Array.isArray(rawRoutes)) {
                // 如果不是数组，转换为数组
                if (typeof rawRoutes === 'object') {
                    const routeArray: RouteEntry[] = [];
                    const rawObject = rawRoutes as Record<string, any>;
                    for (const key in rawObject) {
                        if (Object.prototype.hasOwnProperty.call(rawObject, key)) {
                            const route = rawObject[key];
                            if (route && typeof route === 'object') {
                                routeArray.push({
                                    name: route.name || key,
                                    path: route.path || key,
                                    meta: route.meta || {}
                                });
                            }
                        }
                    }
                    allRoutes = routeArray;
                } else {
                    allRoutes = [];
                }
            } else {
                // 确保数组中的每个元素都有正确的结构
                allRoutes = (rawRoutes as any[]).map(route => {
                    if (typeof route === 'object' && route !== null) {
                        return {
                            name: route.name || '',
                            path: route.path || '',
                            meta: route.meta || {}
                        };
                    }
                    return { name: '', path: route || '', meta: {} };
                });
            }
        }

        result.allRoutes = allRoutes;

        // 序列化清理结果数据
        const sanitizedResult = sanitizeForPostMessage(result);

        window.postMessage({
            type: 'VUE_ROUTER_ANALYSIS_RESULT',
            result: sanitizedResult
        }, '*');
    } catch (error) {
        console.warn('Failed to send router result:', error);
        // 发送最简化版本
        window.postMessage({
            type: 'VUE_ROUTER_ANALYSIS_RESULT',
            result: {
                vueDetected: result?.vueDetected || false,
                routerDetected: result?.routerDetected || false,
                framework: result?.framework || 'vue',
                vueVersion: result?.vueVersion || 'Unknown',
                reactVersion: result?.reactVersion || 'Unknown',
                routerLib: result?.routerLib || '',
                modifiedRoutes: result?.modifiedRoutes || [],
                error: 'Serialization failed',
                allRoutes: []
            }
        }, '*');
    }
}

/**
 * 上报路由分析过程中的错误。
 * @param error - 错误描述文本
 */
export function sendError(error: string): void {
    window.postMessage({
        type: 'VUE_ROUTER_ANALYSIS_ERROR',
        error: error
    }, '*');
}

/* ==================== postMessage 数据清洗 ==================== */

/**
 * 把任意对象清洗为可被 postMessage 结构化克隆的纯数据。
 *
 * 必须清洗的原因：Vue Router 的内部对象含有大量无法克隆的内容
 *   - 函数、Promise        -> 替换为类型标签字符串
 *   - 自定义类实例          -> 替换为 "[类名]"
 *   - 循环引用（parent/router/matched 等）-> 直接跳过
 *
 * 处理策略：
 *   - allRoutes 数组特殊处理，只保留 name / path / meta 三个字段
 *   - 以 _ 或 $ 开头的属性视为内部字段，跳过
 *   - meta / query / params 等浅层对象递归清洗
 *   - 其他深层对象统一替换为 "[Object]"，避免无限递归
 *
 * @param obj - 待清洗的数据
 * @returns 可安全 postMessage 的数据
 */
export function sanitizeForPostMessage(obj: unknown): unknown {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (typeof obj === 'function') {
        return '[Function]';
    }

    if (obj instanceof Promise) {
        return '[Promise]';
    }

    if (typeof obj === 'object') {
        const source = obj as Record<string, any>;

        if (source.constructor && source.constructor.name &&
            !['Object', 'Array'].includes(source.constructor.name)) {
            return `[${source.constructor.name}]`;
        }

        const sanitized: Record<string, any> = Array.isArray(obj) ? [] : {};

        try {
            for (const key in source) {
                if (typeof source.hasOwnProperty === 'function' && source.hasOwnProperty(key)) {
                    const value = source[key];

                    // 特殊处理 allRoutes 数组
                    if (key === 'allRoutes' && Array.isArray(value)) {
                        sanitized[key] = value.map(route => {
                            if (typeof route === 'object' && route !== null) {
                                return {
                                    name: route.name || '',
                                    path: route.path || '',
                                    meta: route.meta ? sanitizeRouteObject(route.meta) : {}
                                };
                            }
                            return route;
                        });
                        continue;
                    }

                    // 跳过可能导致循环引用的属性
                    if (key.startsWith('_') || key.startsWith('$') ||
                        key === 'parent' || key === 'router' || key === 'matched') {
                        continue;
                    }

                    if (typeof value === 'function') {
                        sanitized[key] = '[Function]';
                    } else if (value instanceof Promise) {
                        sanitized[key] = '[Promise]';
                    } else if (Array.isArray(value)) {
                        // 处理数组 - 检查是否是路由数组
                        if (value.length > 0 && value[0] && typeof value[0] === 'object' && value[0].path !== undefined) {
                            // 这是路由数组
                            sanitized[key] = value.map(item => {
                                if (typeof item === 'object' && item !== null) {
                                    return {
                                        name: item.name || '',
                                        path: item.path || '',
                                        meta: item.meta ? sanitizeRouteObject(item.meta) : {}
                                    };
                                }
                                return item;
                            });
                        } else {
                            // 普通数组
                            sanitized[key] = value.map(item => {
                                if (typeof item === 'object' && item !== null) {
                                    return sanitizeRouteObject(item);
                                }
                                return item;
                            });
                        }
                    } else if (typeof value === 'object' && value !== null) {
                        // 简单对象递归处理，避免深度过大
                        if (key === 'meta' || key === 'query' || key === 'params') {
                            sanitized[key] = sanitizeRouteObject(value);
                        } else {
                            sanitized[key] = '[Object]';
                        }
                    } else {
                        sanitized[key] = value;
                    }
                }
            }
        } catch (e) {
            return '[Object - Serialization Error]';
        }

        return sanitized;
    }

    return obj;
}

/**
 * 专门清洗浅层的路由相关对象（meta / query / params 等）。
 *
 * 与 sanitizeForPostMessage 的区别：本函数**不递归**，
 * 遇到嵌套对象一律替换为 "[Object]"，以此切断潜在的超深结构与循环引用。
 *
 * @param obj - 待清洗的浅层对象
 * @returns 清洗后的对象，值类型只会是原始值或类型标签字符串
 */
export function sanitizeRouteObject(obj: unknown): unknown {
    if (!obj || typeof obj !== 'object') {
        return obj;
    }

    const source = obj as Record<string, any>;
    const sanitized: Record<string, any> = {};

    try {
        for (const key in source) {
            if (typeof source.hasOwnProperty === 'function' && source.hasOwnProperty(key)) {
                const value = source[key];

                if (typeof value === 'function') {
                    sanitized[key] = '[Function]';
                } else if (value instanceof Promise) {
                    sanitized[key] = '[Promise]';
                } else if (typeof value === 'object' && value !== null) {
                    // 避免深度递归
                    sanitized[key] = '[Object]';
                } else {
                    sanitized[key] = value;
                }
            }
        }
    } catch (e) {
        return '[Route Object - Serialization Error]';
    }

    return sanitized;
}

/* ==================== 页面链接分析（Vue / React 复用） ==================== */

/** 页面链接缓存：避免重复查询 DOM（一次分析中会多次用到） */
const linkCache = new Map<string, string[]>();

/**
 * 获取页面中疑似路由链接的 href 列表（带缓存）。
 *
 * 筛选条件：
 *   - 以 / 开头（站内绝对路径）
 *   - 不以 // 开头（排除协议相对 URL）
 *   - 不含 .（排除带扩展名的静态资源链接）
 *
 * @returns 疑似路由路径列表
 */
function getCachedLinks(): string[] {
    const cacheKey = 'page-links';
    if (linkCache.has(cacheKey)) {
        return linkCache.get(cacheKey) as string[];
    }

    const links = Array.from(document.querySelectorAll('a[href]'))
        .map(a => a.getAttribute('href'))
        .filter((href): href is string =>
            !!href &&
            href.startsWith('/') &&
            !href.startsWith('//') &&
            !href.includes('.')
        );

    linkCache.set(cacheKey, links);
    return links;
}

/**
 * 分析页面链接，推测 Router 的候选基础路径。
 *
 * 思路：统计所有站内链接的第一段路径，若某个前缀占比超过 60%，
 * 则很可能是部署基础路径（如大量链接形如 /admin/xxx）。
 *
 * 结果作为**候选值**：可信度低于 router.options.base，
 * popup 仅在未取到显式 base 时才会考虑使用。
 *
 * @returns 推测出的基础路径与各前缀的命中统计
 */
export function analyzePageLinks(): PageAnalysisResult {
    const result: PageAnalysisResult = {
        detectedBasePath: '',
        commonPrefixes: []
    };

    try {
        const links = getCachedLinks();

        // 样本过少时统计无意义，直接返回空结果
        if (links.length < 3) return result;

        // 取每个链接的第一段路径并计数
        const pathSegments = links.map(link => link.split('/').filter(Boolean));
        const firstSegments: Record<string, number> = {};

        pathSegments.forEach(segments => {
            if (segments.length > 0) {
                const first = segments[0];
                firstSegments[first] = (firstSegments[first] || 0) + 1;
            }
        });

        const sortedPrefixes = Object.entries(firstSegments)
            .sort((a, b) => b[1] - a[1])
            .map(entry => ({ prefix: entry[0], count: entry[1] }));

        result.commonPrefixes = sortedPrefixes;

        // 最高频前缀占比超过 60% 才认定为候选基础路径，避免误判
        if (sortedPrefixes.length > 0 &&
            sortedPrefixes[0].count / links.length > 0.6) {
            result.detectedBasePath = '/' + sortedPrefixes[0].prefix;
        }
    } catch (e) {
        handleError(e, '分析页面链接');
    }

    return result;
}
