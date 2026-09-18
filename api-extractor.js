(function() {
    // API端点提取器：按需注入页面MAIN world
    // 数据源：1) performance中已发出的xhr/fetch真实请求
    //         2) 已加载JS源码(含懒加载chunk)静态正则提取
    //         3) sourceMappingURL指向的.map文件可达性探测

    const RUNNING_KEY = '__VUECRACK_API_EXTRACT_RUNNING__';
    const MAX_SCRIPTS = 80;
    const FETCH_TIMEOUT = 8000;

    if (window[RUNNING_KEY]) {
        return;
    }
    try {
        window[RUNNING_KEY] = true;
    } catch (e) {
        return;
    }

    /**
     * 向内容脚本统一发送消息（基础方法）。
     *
     * 自动附带 source 标识，便于 content.js 区分消息来源。
     * 发送失败（如页面消息通道被禁用）时静默忽略，不影响提取主流程。
     *
     * @param {string} type - 消息类型，如 'VUECRACK_API_EXTRACT_RESULT'
     * @param {Object} payload - 要附加到消息上的数据字段
     */
    function send(type, payload) {
        try {
            window.postMessage(Object.assign({
                type: type,
                source: 'vuecrack-api-extractor'
            }, payload), '*');
        } catch (e) {
            // 页面消息不可用时不影响提取流程
        }
    }

    /**
     * 上报提取进度，用于 popup 展示"正在分析 JS 3/12"之类的实时进度。
     * @param {string} message - 进度描述文本
     */
    function sendProgress(message) {
        send('VUECRACK_API_EXTRACT_PROGRESS', { message: message });
    }

    /**
     * 上报最终提取结果。
     * @param {Object} result - 包含 liveApis / staticApis / sourceMaps 等字段的结果对象
     */
    function sendResult(result) {
        send('VUECRACK_API_EXTRACT_RESULT', { result: result });
    }

    /**
     * 带超时的 fetch 封装。
     *
     * 批量拉取 JS 源码时，任一请求卡住都会拖慢整个串行流程，
     * 因此用 AbortController 在 FETCH_TIMEOUT 毫秒后强制中断。
     * 使用 credentials: 'omit' 避免携带 Cookie，减少对目标侧的副作用。
     *
     * @param {string} url - 请求地址
     * @returns {Promise<Response>} fetch 的 Promise，超时会被 reject
     */
    function fetchWithTimeout(url) {
        const controller = new AbortController();
        const timer = setTimeout(function() { controller.abort(); }, FETCH_TIMEOUT);
        return fetch(url, { credentials: 'omit', signal: controller.signal })
            .finally(function() { clearTimeout(timer); });
    }

    // ===== 静态资源过滤 =====
    var STATIC_EXT_RE = /\.(js|mjs|css|png|jpe?g|gif|svg|ico|woff2?|ttf|eot|otf|map|html?|mp4|webp|webm|pdf|zip|txt)(\?|$)/i;
    var API_PREFIX_RE = /\/(api|apis|apiv\d|v\d{1,2}|rest|gateway|gw|svc|service|services|auth|oauth|sso|login|logout|register|user|users|admin|sys|system|manage|manager|mgr|portal|open|openapi|internal|backend|server|rpc|graphql)(\/|$)/i;
    // 无前导斜杠的相对路径前缀（axios 已配置 baseURL 时源码里常见）
    var REL_API_PREFIX_RE = /^(api|apis|apiv\d|v\d{1,2}|rest|gateway|gw|svc|service|services|auth|oauth|sso|login|logout|register|user|users|admin|sys|system|manage|manager|mgr|portal|open|openapi|internal|backend|server|rpc|graphql)(\/|$)/i;
    var STATIC_DIR_RE = /^(\/)?(assets|static|img|images|fonts|icons|css|js|dist|build|public|vendor|lib|libs|media|file|files)(\/|$)/i;
    var ACTION_WORD_RE = /(get|list|query|create|add|update|edit|del|delete|remove|export|import|upload|download|search|find|save|submit|check|verify|send|login|logout|register|info|detail|page|count|stat|log|audit|menu|role|perm|token|captcha|sms|mail|notify|order|pay|bill|account)/i;

    /**
     * 判断一个"带前导斜杠的路径"是否像 API 端点。
     *
     * 降噪规则（按顺序短路）：
     *   1. 长度必须在 4~200 之间，过短或过长都视为噪音
     *   2. 以 // 开头的是协议相对 URL，不是路径
     *   3. 命中静态资源扩展名（.js/.css/.png 等）直接排除
     *   4. 路径分段少于 2 段（如 "/login"）排除，避免误收页面路由
     *   5. 命中静态目录前缀（assets/static/dist 等）排除
     * 最终只要命中 API 前缀词或动作词即视为端点。
     *
     * @param {string} path - 形如 "/api/user/list" 的路径
     * @returns {boolean} true 表示像 API 端点
     */
    function isApiLikePath(path) {
        if (!path || path.length < 4 || path.length > 200) return false;
        if (path.indexOf('//') === 0) return false;
        if (STATIC_EXT_RE.test(path)) return false;
        var segments = path.split('/').filter(Boolean);
        if (segments.length < 2) return false;
        if (STATIC_DIR_RE.test(path)) return false;
        if (API_PREFIX_RE.test(path)) return true;
        if (ACTION_WORD_RE.test(path)) return true;
        return false;
    }

    /**
     * 判断一个"无前导斜杠的相对路径"是否像 API 端点。
     *
     * 场景：axios 已配置 baseURL 时，源码中写的是 'sys/User/userLogin' 这种相对路径。
     * 难点：webpack 的模块标识也是类似形态（如 'aya4/Dd8w'），必须区分开。
     * 区分方式：若所有分段都是 1~6 位短标识且不含 API 前缀词/动作词，
     * 则判定为模块名噪音并排除。
     *
     * @param {string} path - 形如 "sys/User/userLogin" 的相对路径
     * @returns {boolean} true 表示像 API 端点
     */
    function isApiLikeRelativePath(path) {
        if (!path || path.length < 6 || path.length > 200) return false;
        if (path.indexOf('/') === -1) return false;
        // 排除完整 URL、相对路径符号和绝对路径（这些由其他分支处理）
        if (/^https?:|^\.\.?\/|^\//.test(path)) return false;
        if (STATIC_EXT_RE.test('/' + path)) return false;
        var segments = path.split('/').filter(Boolean);
        if (segments.length < 2) return false;
        // 过滤掉 webpack 模块名噪音，如 "aya4/Dd8w"
        var allShortIds = segments.every(function(s) { return /^[a-z0-9_\-]{1,6}$/i.test(s); });
        if (allShortIds && !REL_API_PREFIX_RE.test(path) && !ACTION_WORD_RE.test(path)) return false;
        if (REL_API_PREFIX_RE.test(path)) return true;
        if (ACTION_WORD_RE.test(path)) return true;
        return false;
    }

    /**
     * 去掉路径中的模板参数占位符，得到可比较的前缀。
     *
     * 用于判断"已发出请求"是否命中了某个静态端点：
     * 源码里是 /api/user/${id}，实际请求是 /api/user/123，
     * 两者需要归一化后才能匹配。
     *
     * @param {string} path - 含模板参数的路径
     * @returns {string} 去掉 ${...} / :param / {..} 后的路径
     */
    function cleanTemplatePath(path) {
        // 将 /api/user/${id} / /api/user/:id / /api/user/{id} 统一为前缀形式便于比对
        return path
            .replace(/\$\{[^}]*\}/g, '')
            .replace(/:[A-Za-z0-9_]+/g, '')
            .replace(/\{[^}]*\}/g, '');
    }

    /**
     * 把模板参数填充为样例值，生成可直接请求的 URL。
     * 三种写法统一替换为 '1'：${id} -> 1，:id -> 1，{id} -> 1
     *
     * @param {string} pathname - 含模板参数的 pathname
     * @returns {string} 参数已填充的 pathname
     */
    function fillTemplateParams(pathname) {
        return pathname
            .replace(/\$\{[^}]*\}/g, '1')
            .replace(/:([A-Za-z_][A-Za-z0-9_]*)(?=[\/#?]|$)/g, '1')
            .replace(/\{[^}]*\}/g, '1');
    }

    /**
     * 把提取到的路径拼接成完整可访问 URL。
     *
     * 两种输入分别处理：
     *   - 已是完整 URL（跨域后端）：解析后仅替换 pathname 中的模板参数
     *   - 相对路径：补上前导斜杠，再拼上当前页面 origin
     *
     * @param {string} path - 提取到的端点路径或完整 URL
     * @returns {string} 可直接请求的完整 URL
     */
    function buildFullUrl(path) {
        if (/^https?:\/\//i.test(path)) {
            try {
                var u = new URL(path);
                u.pathname = fillTemplateParams(u.pathname);
                return u.href;
            } catch (e) {
                return path;
            }
        }
        var normalized = path.charAt(0) === '/' ? path : '/' + path;
        return location.origin + fillTemplateParams(normalized);
    }

    // ===== 1. 收集JS资源 =====

    /**
     * 收集当前页面加载过的所有 JS 资源 URL。
     *
     * 双数据源，互补覆盖：
     *   - DOM 中的 <script src>：捕获主力脚本
     *   - performance resource 条目：捕获**懒加载 chunk**（这些脚本
     *     动态插入后可能已被移除，DOM 查询不到，但 performance 有记录）
     * 按出现顺序去重，并截断到 MAX_SCRIPTS 个以控制扫描耗时。
     *
     * @returns {string[]} 去重后的 JS 绝对 URL 列表
     */
    function collectScriptSources() {
        var urls = [];
        var seen = Object.create(null);

        // 内部去重添加
        function add(u) {
            if (!u || seen[u]) return;
            seen[u] = true;
            urls.push(u);
        }

        try {
            document.querySelectorAll('script[src]').forEach(function(s) {
                try { add(new URL(s.src, location.href).href); } catch (e) {}
            });
        } catch (e) {}

        try {
            performance.getEntriesByType('resource').forEach(function(entry) {
                var name = entry.name || '';
                var isJs = /\.js(\?|$)/.test(name.split('#')[0]);
                if (entry.initiatorType === 'script' || isJs) {
                    try { add(new URL(name, location.href).href); } catch (e) {}
                }
            });
        } catch (e) {}

        return urls.slice(0, MAX_SCRIPTS);
    }

    /**
     * 收集页面内联脚本的源码文本。
     * 内联脚本常见于服务端注入的配置项（如 window.__CONFIG__ = { api: '/api' }），
     * 是端点提取的重要补充来源。过滤掉长度不足 20 字符的碎片。
     *
     * @returns {string[]} 内联脚本源码文本列表
     */
    function collectInlineScripts() {
        var texts = [];
        try {
            document.querySelectorAll('script:not([src])').forEach(function(s) {
                var t = s.textContent || '';
                if (t.trim().length > 20) {
                    texts.push(t);
                }
            });
        } catch (e) {}
        return texts;
    }

    // ===== 2. 页面已发出的真实请求 =====

    /**
     * 从 performance 中提取页面已真实发出的 XHR / fetch 请求。
     *
     * 这类端点是"确定存在且可用"的，可信度最高。
     * 只保留 http/https 协议，并过滤掉静态资源请求。
     *
     * 注意：调用方需在自身发起 fetch 之前调用本函数，
     * 否则会把提取器自己的请求也算进来，造成数据污染。
     *
     * @returns {Array<{url: string, path: string}>} 真实请求列表（url 为完整地址，path 为路径+查询串）
     */
    function collectLiveApiCalls() {
        var results = [];
        var seen = Object.create(null);

        try {
            performance.getEntriesByType('resource').forEach(function(entry) {
                var it = entry.initiatorType;
                // 只关心接口类请求，排除 img/script/css 等
                if (it !== 'xmlhttprequest' && it !== 'fetch') return;

                var url = entry.name;
                if (seen[url]) return;

                var u;
                try { u = new URL(url); } catch (e) { return; }
                if (!/^https?:$/.test(u.protocol)) return;
                if (STATIC_EXT_RE.test(u.pathname)) return;

                seen[url] = true;
                results.push({
                    url: url,
                    path: u.pathname + (u.search || '')
                });
            });
        } catch (e) {}

        return results;
    }

    // ===== 3. 从JS文本提取端点 =====

    /**
     * 从一段 JS 源码文本中正则提取 API 端点，结果写入 endpoints 累加器。
     *
     * 依次匹配三种形态：
     *   1. 引号内以 / 开头的路径          -> "/api/user/list"
     *   2. 引号内无前导斜杠的相对路径      -> "sys/User/userLogin"（axios 配了 baseURL 的场景）
     *   3. 引号内的完整 URL               -> "https://api.example.com/v1/xxx"（跨域后端）
     *
     * 每种形态都会经过对应的 isApiLikeXxx 降噪判断后才收录，
     * 避免把静态资源路径、webpack 模块名误认为接口。
     *
     * @param {string} text - JS 源码文本（外部文件内容或内联脚本内容）
     * @param {Object} endpoints - 累加器对象，key 为端点路径，值为 {path, sources}
     * @param {string} sourceLabel - 来源标识，如 "app.js" 或 "inline#1"
     */
    function extractFromText(text, endpoints, sourceLabel) {
        if (!text) return;

        var m;

        // 形态 1：引号字符串中以 / 开头的路径
        var stringRe = /(["'`])((?:\/)[A-Za-z0-9_\-./:{}$]+)\1/g;
        while ((m = stringRe.exec(text)) !== null) {
            var path = m[2];
            if (isApiLikePath(path)) {
                addEndpoint(endpoints, path, sourceLabel);
            }
        }

        // 形态 2：无前导斜杠的相对路径（axios 已配置 baseURL）
        var relStringRe = /(["'`])(?!\/|https?:\/\/|\.\.?\/)([A-Za-z0-9_\-./:{}$]+)\1/g;
        while ((m = relStringRe.exec(text)) !== null) {
            var relPath = m[2];
            if (isApiLikeRelativePath(relPath)) {
                addEndpoint(endpoints, relPath, sourceLabel);
            }
        }

        // 形态 3：完整URL形式的接口地址（跨域后端域名）
        var urlRe = /(["'`])(https?:\/\/[A-Za-z0-9_\-./:{}$]+)\1/g;
        while ((m = urlRe.exec(text)) !== null) {
            var full = m[2];
            try {
                var u = new URL(full);
                if (API_PREFIX_RE.test(u.pathname)) {
                    addEndpoint(endpoints, full, sourceLabel);
                }
            } catch (e) {}
        }
    }

    /**
     * 向累加器中登记一个端点（去重 + 记录来源）。
     *
     * 同一端点可能在多个 JS 文件中出现，此处合并为一条记录，
     * 并把来源文件名记入 sources（最多保留 5 个），便于溯源定位。
     *
     * @param {Object} endpoints - 端点累加器
     * @param {string} path - 端点路径
     * @param {string} sourceLabel - 来源标识
     */
    function addEndpoint(endpoints, path, sourceLabel) {
        var entry = endpoints[path];
        if (!entry) {
            entry = { path: path, sources: [] };
            endpoints[path] = entry;
        }
        if (sourceLabel && entry.sources.indexOf(sourceLabel) === -1 && entry.sources.length < 5) {
            entry.sources.push(sourceLabel);
        }
    }

    /**
     * 从 JS 源码尾部注释中解析 sourceMappingURL。
     * 形如：//# sourceMappingURL=app.js.map
     *
     * @param {string} text - JS 源码文本
     * @returns {string|null} map 文件引用（可能是相对路径）；未找到时为 null
     */
    function findSourceMappingURL(text) {
        var m = text.match(/[#@]\s*sourceMappingURL=(\S+)/);
        return m ? m[1] : null;
    }

    /**
     * 探测 sourcemap 文件是否真实可访问（源码泄露检测）。
     *
     * 仅当响应为 JSON / JS 类型时才判定为有效泄露，
     * 避免把 SPA 的兜底 HTML（未命中时返回 index.html）误判为 map 文件。
     * 内联 data: 形式的 map 由调用方提前过滤，此处不处理。
     *
     * @param {string} scriptUrl - 引用该 map 的 JS 文件地址，用于解析相对路径
     * @param {string} mapRef - sourceMappingURL 的值
     * @returns {Promise<{scriptUrl: string, mapUrl: string}|null>} 可访问时返回信息对象，否则 null
     */
    function checkSourceMap(scriptUrl, mapRef) {
        var mapUrl;
        try {
            mapUrl = new URL(mapRef, scriptUrl).href;
        } catch (e) {
            return Promise.resolve(null);
        }

        return fetchWithTimeout(mapUrl).then(function(resp) {
            if (!resp.ok) return null;
            var ct = (resp.headers.get('content-type') || '').toLowerCase();
            // 内容类型为 JSON / JS 才认定为真实 map，避免 SPA 兜底页误判
            if (ct.indexOf('json') !== -1 || ct.indexOf('javascript') !== -1 || ct === '') {
                return { scriptUrl: scriptUrl, mapUrl: mapUrl };
            }
            return null;
        }).catch(function() {
            return null;
        });
    }

    /**
     * 取 URL 的文件名部分，用于界面展示与来源标注。
     * 例如 "https://cdn.site.com/js/app.3f2a.js" -> "app.3f2a.js"
     *
     * @param {string} url - 完整 URL
     * @returns {string} 文件名；解析失败时原样返回
     */
    function shortSource(url) {
        try {
            var u = new URL(url);
            var name = u.pathname.split('/').pop() || u.pathname;
            return name;
        } catch (e) {
            return url;
        }
    }

    // ===== 主流程 =====

    /**
     * 提取主流程。
     *
     * 执行顺序（顺序敏感，不可随意调整）：
     *   1. 快照 performance 中的真实请求 —— 必须在自身发起任何 fetch 之前，
     *      否则提取器自己的请求会混入结果
     *   2. 提取内联脚本中的端点
     *   3. 串行拉取并分析每个外部 JS 文件
     *      - 串行而非并行：控制瞬时并发与目标站压力，同时便于上报精确进度
     *      - 每个文件分析后顺带探测其 sourcemap 是否泄露
     *   4. 汇总结果：标记每个静态端点是否已被真实调用，生成完整 URL，排序后上报
     *
     * 用 RUNNING_KEY 做重入保护，流程结束（无论成功失败）都会释放该锁。
     */
    function run() {
        var finished = false;

        /**
         * 结束本次提取并释放重入锁。
         * 用 finished 标志保证只执行一次，避免成功与异常分支重复释放。
         */
        function done() {
            if (finished) return;
            finished = true;
            window[RUNNING_KEY] = false;
        }

        sendProgress('正在收集JS资源...');

        var scriptUrls = collectScriptSources();
        var inlineScripts = collectInlineScripts();
        // 先快照真实请求，避免把本提取器自己的fetch算进去
        var liveApis = collectLiveApiCalls();

        var endpoints = Object.create(null);
        var sourceMaps = [];
        var failedScripts = [];

        // 内联脚本为纯文本，可同步分析
        inlineScripts.forEach(function(text, i) {
            extractFromText(text, endpoints, 'inline#' + (i + 1));
        });

        // 把外部 JS 的拉取与分析串成 Promise 链，逐个串行执行
        var chain = Promise.resolve();

        scriptUrls.forEach(function(url, i) {
            chain = chain.then(function() {
                sendProgress('正在分析JS ' + (i + 1) + '/' + scriptUrls.length + '：' + shortSource(url));

                return fetchWithTimeout(url).then(function(resp) {
                    if (!resp.ok) {
                        failedScripts.push(url);
                        return null;
                    }
                    return resp.text();
                }).then(function(text) {
                    if (!text) return;

                    extractFromText(text, endpoints, shortSource(url));

                    // 顺带探测 sourcemap 泄露（内联 data: 形式无需网络探测，跳过）
                    var mapRef = findSourceMappingURL(text);
                    if (mapRef && mapRef.indexOf('data:') !== 0) {
                        return checkSourceMap(url, mapRef).then(function(r) {
                            if (r) sourceMaps.push(r);
                        });
                    }
                }).catch(function() {
                    // 单文件失败（跨域受限等）不影响整体流程，仅记录
                    failedScripts.push(url);
                });
            });
        });

        // 全部文件处理完毕后，汇总并上报
        chain.then(function() {
            // 标记静态端点是否已被当前页面实际调用
            var livePrefixes = liveApis.map(function(item) {
                try { return new URL(item.url).pathname; } catch (e) { return item.path; }
            });

            var staticApis = Object.keys(endpoints).map(function(path) {
                var entry = endpoints[path];
                // 归一化后比对：源码里是 /api/user/${id}，实际请求是 /api/user/123
                var cleaned = cleanTemplatePath(path);
                var called = livePrefixes.some(function(livePath) {
                    return livePath === cleaned || (cleaned.length > 1 && livePath.indexOf(cleaned) === 0);
                });
                return {
                    path: path,
                    fullUrl: buildFullUrl(path),
                    // 是否含模板参数，界面用于显示"参数"徽标
                    hasParams: /(\$\{[^}]*\}|\/:[A-Za-z_][A-Za-z0-9_]*|\{[^}]*\})/.test(path),
                    sources: entry.sources,
                    called: called
                };
            }).sort(function(a, b) { return a.path.localeCompare(b.path); });

            sendResult({
                pageUrl: location.href,
                origin: location.origin,
                scriptCount: scriptUrls.length,
                inlineScriptCount: inlineScripts.length,
                liveApis: liveApis,
                staticApis: staticApis,
                sourceMaps: sourceMaps,
                failedScripts: failedScripts,
                extractedAt: Date.now()
            });
            done();
        }).catch(function(e) {
            // 兜底异常：上报错误并释放锁
            send('VUECRACK_API_EXTRACT_ERROR', { error: String(e) });
            done();
        });
    }

    run();
})();
