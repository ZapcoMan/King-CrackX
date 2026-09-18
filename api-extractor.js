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

    function sendProgress(message) {
        send('VUECRACK_API_EXTRACT_PROGRESS', { message: message });
    }

    function sendResult(result) {
        send('VUECRACK_API_EXTRACT_RESULT', { result: result });
    }

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

    // 抓类似 "sys/User/userLogin" 这种 axios baseURL 场景下的相对路径
    function isApiLikeRelativePath(path) {
        if (!path || path.length < 6 || path.length > 200) return false;
        if (path.indexOf('/') === -1) return false;
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

    function cleanTemplatePath(path) {
        // 将 /api/user/${id} / /api/user/:id / /api/user/{id} 统一为前缀形式便于比对
        return path
            .replace(/\$\{[^}]*\}/g, '')
            .replace(/:[A-Za-z0-9_]+/g, '')
            .replace(/\{[^}]*\}/g, '');
    }

    // 将模板参数填充为样例值，生成Burp可直接请求的URL
    // :id / ${id} / {id} -> 1
    function fillTemplateParams(pathname) {
        return pathname
            .replace(/\$\{[^}]*\}/g, '1')
            .replace(/:([A-Za-z_][A-Za-z0-9_]*)(?=[\/#?]|$)/g, '1')
            .replace(/\{[^}]*\}/g, '1');
    }

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
    function collectScriptSources() {
        var urls = [];
        var seen = Object.create(null);

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
    function collectLiveApiCalls() {
        var results = [];
        var seen = Object.create(null);

        try {
            performance.getEntriesByType('resource').forEach(function(entry) {
                var it = entry.initiatorType;
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
    function extractFromText(text, endpoints, sourceLabel) {
        if (!text) return;

        // 引号字符串中以/开头的路径
        var stringRe = /(["'`])((?:\/)[A-Za-z0-9_\-./:{}$]+)\1/g;
        var m;
        while ((m = stringRe.exec(text)) !== null) {
            var path = m[2];
            if (isApiLikePath(path)) {
                addEndpoint(endpoints, path, sourceLabel);
            }
        }

        // 无前导斜杠的相对路径（axios 已配置 baseURL）
        var relStringRe = /(["'`])(?!\/|https?:\/\/|\.\.?\/)([A-Za-z0-9_\-./:{}$]+)\1/g;
        while ((m = relStringRe.exec(text)) !== null) {
            var relPath = m[2];
            if (isApiLikeRelativePath(relPath)) {
                addEndpoint(endpoints, relPath, sourceLabel);
            }
        }

        // 完整URL形式的接口地址（跨域后端域名）
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

    function findSourceMappingURL(text) {
        var m = text.match(/[#@]\s*sourceMappingURL=(\S+)/);
        return m ? m[1] : null;
    }

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
            if (ct.indexOf('json') !== -1 || ct.indexOf('javascript') !== -1 || ct === '') {
                return { scriptUrl: scriptUrl, mapUrl: mapUrl };
            }
            return null;
        }).catch(function() {
            return null;
        });
    }

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
    function run() {
        var finished = false;
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

        inlineScripts.forEach(function(text, i) {
            extractFromText(text, endpoints, 'inline#' + (i + 1));
        });

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

                    var mapRef = findSourceMappingURL(text);
                    if (mapRef && mapRef.indexOf('data:') !== 0) {
                        return checkSourceMap(url, mapRef).then(function(r) {
                            if (r) sourceMaps.push(r);
                        });
                    }
                }).catch(function() {
                    failedScripts.push(url);
                });
            });
        });

        chain.then(function() {
            // 标记静态端点是否已被当前页面实际调用
            var livePrefixes = liveApis.map(function(item) {
                try { return new URL(item.url).pathname; } catch (e) { return item.path; }
            });

            var staticApis = Object.keys(endpoints).map(function(path) {
                var entry = endpoints[path];
                var cleaned = cleanTemplatePath(path);
                var called = livePrefixes.some(function(livePath) {
                    return livePath === cleaned || (cleaned.length > 1 && livePath.indexOf(cleaned) === 0);
                });
                return {
                    path: path,
                    fullUrl: buildFullUrl(path),
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
            send('VUECRACK_API_EXTRACT_ERROR', { error: String(e) });
            done();
        });
    }

    run();
})();
