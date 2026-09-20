# 功能实现原理

> 本文档是 [README](../README.md) 的补充材料，逐条说明 README 里列出的功能**是怎么用代码实现的**。
> 每节的结构是：目标 → 实现于哪个文件 → 关键函数与设计取舍。

### 1. Vue 框架与版本检测

**目标**：识别页面是否使用 Vue、是 Vue 2 还是 Vue 3、版本号是多少，并兼容「Vue 延迟挂载」的页面。

**实现于** `src/extension/detector.ts`

#### ① 找 Vue 根实例 —— `findVueRoot(root, maxDepth = 1000)`

对 `document.body` 做**广度优先遍历**，逐个节点检查三个内部属性，命中任意一个即认定为 Vue 挂载点：

| 属性 | 来源 |
| --- | --- |
| `__vue_app__` | Vue 3 应用实例 |
| `__vue__` | Vue 2 组件实例 |
| `_vnode` | Vue 内部虚拟节点引用 |

- **为什么用 BFS 而不是递归**：Vue 根实例通常挂在很浅的节点上，逐层扫描能在几十个节点内命中，避免无谓遍历整棵 DOM。
- `maxDepth = 1000` 是防护：深层嵌套页面不会让遍历失控。

#### ② 取版本号 —— `getVueVersion(vueRoot)`

按可信度依次尝试四个来源，取到即停：

1. Vue 3：`__vue_app__.version`
2. Vue 2：`__vue__.$root.$options._base.version`
3. 全局构造器：`window.Vue.version`（UMD 构建才有）
4. Vue DevTools 钩子：`window.__VUE_DEVTOOLS_GLOBAL_HOOK__.Vue.version`（生产环境常见）

四个都拿不到时返回 `'unknown'`，界面显示为 `Unknown`。

#### ③ 应对延迟挂载 —— `delayedDetection(delay, retryCount)`

部分页面首屏之后 Vue 才初始化（等接口返回、异步路由），立即检测会误判成「不是 Vue 应用」。因此：

```
注入后立即检测
├─ 命中 → 上报 { detected: true, method: 'Immediate detection' }
│         └─ 等 50ms 再执行完整分析（给框架留出内部初始化时间）
└─ 未命中 → delayedDetection(0)        第 0ms 重试
            ├─ 未命中 → delayedDetection(300)    300ms
            │           └─ 未命中 → delayedDetection(600)   600ms
            │                       └─ 仍未命中 → 上报「未检测到 Vue」
```

`retryCount >= 3` 时停止，避免在非 Vue 页面上无限重试。

#### ④ 结果如何回到 popup

检测结果与完整分析结果都通过 `window.postMessage` 发出（`VUE_DETECTION_RESULT` / `VUE_ROUTER_ANALYSIS_RESULT`），再由 `content.ts` 转发给 popup。**「先发轻量的检测结果、再发完整的分析结果」是刻意的**：让 popup 立刻有反馈，而不是干等一次耗时较长的完整分析。

### 2. 路由信息枚举与 URL 生成

**目标**：拿到 Vue Router 的全部路由（含嵌套子路由），并按 Hash / History 模式生成可直接访问的完整 URL。

**实现分两半**：枚举在 MAIN world（`src/extension/detector.ts`），URL 拼接在 popup（`src/utils/routeUrls.ts`）。

#### ① 定位 Router 实例 —— `findVueRouter(vueRoot)`

Vue 2 与 Vue 3 暴露 `$router` 的位置不同，完整版 / 运行时版构建也有差异，因此按顺序逐个尝试：

**Vue 3 + Router 4**
1. `app.config.globalProperties.$router`
2. `app._instance.appContext.config.globalProperties.$router`
3. `app._instance.ctx.$router`

**Vue 2 + Router 2/3**
1. `vue.$router`
2. `vue.$root.$router`
3. `vue.$root.$options.router`
4. `vue._router`

#### ② 枚举全部路由 —— `listAllRoutes(router)`

按优先级尝试四种数据来源，覆盖不同版本与不同暴露程度：

| 优先级 | 来源 | 适用范围 |
| --- | --- | --- |
| 1 | `router.getRoutes()` | Vue Router 4 标准接口 |
| 2 | `router.options.routes` | Vue Router 2/3 原始配置（**需递归拼路径**） |
| 3 | `router.matcher.getRoutes()` | 内部匹配器 |
| 4 | `router.history.current.matched` | 兜底：至少拿到当前匹配链 |

第 2 种来源是**嵌套路由的原始配置**，子路由的 `path` 是相对的，因此用内部的 `traverse()` 递归展开，再用 `joinPath(base, path)` 拼成完整路径：

- 子路径为空 → 沿用父路径
- 子路径以 `/` 开头 → 视为绝对路径直接采用（Vue Router 的嵌套语义）
- 否则 → 父路径去掉结尾斜杠后，与子路径用 `/` 拼接

#### ③ 改写鉴权 meta、清除路由守卫

- `patchAllRouteAuth(router)`：遍历所有路由的 `meta`，把 **key 中含 `auth` 且值为真**的字段改写为 `false`（如 `meta.requiresAuth`），使前端路由级鉴权判断失效。
- `patchRouterGuards(router)`：把 `beforeEach` / `beforeResolve` / `afterEach` 替换为空函数，并清空已知的守卫容器数组。

这两步属于**温和模式** —— 一次性清理，不做原型级接管，也不拦截跳转。真正强力的接管是「梭哈模式」（见第 3 节）。

#### ④ 推测 Router 基础路径 —— `analyzePageLinks()`

路由可能部署在子目录下（如 `/admin/`），这时必须知道 base 才能拼出正确 URL。数据来自两处，可信度不同：

1. **可信值**：`router.options.base` → 其次 `router.history.base`
2. **候选值**：统计页面所有 `<a href>` 的第一段路径，若某个前缀占比 **超过 60%**，推测它就是部署基础路径

候选值只在拿不到可信值时才启用（`routeUrls.ts` 中的 `trustedBasePath || candidateBasePath`）。

#### ⑤ 生成完整 URL —— `buildRouteUrlList()`（`src/utils/routeUrls.ts`）

先判断页面处于哪种模式：

- **Hash 模式**：URL 里含 `#`，真实路径在 `#` 之后，`baseUrl` 截到 `#` 为止（含）
- **History 模式**：`baseUrl` 就是 `origin`

然后按模式拼接：

```
Hash 模式
  baseUrl 以 '#'  结尾 → `${baseUrl}/${path}`      得到 http://site/#/path
  baseUrl 以 '#/' 结尾 → `${baseUrl}${path}`
  其他                 → `${baseUrl}#/${path}`

History 模式
  标准       → `${origin}${path}`
  带基础路径 → `${origin}${basePath}${path}`
               （路由自身已含 basePath 前缀时不再重复拼接）
```

界面上可以手动切换「标准 / 带基础路径」，选择结果按 `origin` 记在内存中（`basePathModeByOrigin`），同一站点下切换页面后仍然记得。

若用户没手动选过，就用**上次打开过的路由**反推他上次用的是哪种模式 —— 哪个列表能匹配到那条 URL，就认为用的是哪个模式。

#### ⑥ 去重与容错

- `dedupeRoutes()`：按归一化后的 `path` 去重，同时过滤结构不合法（缺 `path`）的条目
- `dedupeUrlItems()`：按归一化后的 URL 去重
- `normalizeRoutePath()` / `cleanUrl()`：统一处理前导斜杠、结尾斜杠、重复斜杠

### 3. 梭哈模式（强制接管 Vue Router）

**目标**：在页面业务代码执行**之前**抢跑，把路由守卫与鉴权跳转全部废掉，从而直接访问受保护路由。

**实现于** `src/extension/all-in.ts`，由 `src/extension/background.ts` 动态注册

#### ① 为什么必须动态注册

`all-in` 必须在 `document_start` 阶段以 `world: 'MAIN'` 注入，并且**只对用户开启过的站点生效**。而 manifest 里的 `content_scripts` 是静态声明、对所有站点生效的，做不到按站点开关。所以由 `background.ts` 通过 `chrome.scripting.registerContentScripts` 按白名单注册：

```ts
{
    id: 'vuecrack-all-in-script',
    js: ['all-in.js'],
    matches,                     // 由白名单生成，形如 *://example.com/*
    runAt: 'document_start',     // 抢在页面框架代码之前执行
    world: 'MAIN',               // 必须主世界才能碰到 Vue 内部对象
    allFrames: true              // iframe 中的 Vue 应用同样接管
}
```

白名单存于 `chrome.storage.local` 的 `vuecrack_all_in_sites`（形如 `{ "example.com": true }`）。popup 切换开关 → 写入 storage → `background.ts` 监听到变更（或收到 `syncAllInMode` 消息）→ **先全部注销、再按需注册**。之所以整体重建而不是增量更新，是因为 Chrome 对已存在的 `id` 调用注册接口会直接报错。

注册/注销操作被一条 Promise 链**串行排队**（`queueSyncAllInScript`），避免「安装 / 启动 / storage 变更 / popup 消息」多个触发源并发互相干扰。

#### ② 三层拦截

| 层 | 手段 | 拦住了什么 |
| --- | --- | --- |
| **守卫注册层** | 替换 `beforeEach` / `beforeResolve` / `afterEach` | 页面**后续**注册的守卫全被静默吞掉 |
| **存量守卫层** | 清空 9 个已知守卫容器 | 接管**之前**已经注册的守卫 |
| **跳转层** | 替换 `router.push/replace/go`、`history.*`、`location.assign/replace`、`window.close` | 防止被踢回登录页 |

**守卫注册层 —— `makeGuardBlocker(name)`**

把 `router.beforeEach` 等替换成 blocker：调用时只累加计数并上报，然后**返回一个空的移除函数**。这一点很关键 —— 调用方通常写 `const off = router.beforeEach(...)`，返回 `undefined` 会让它后续调用 `off()` 时崩掉。

**存量守卫层 —— `clearKnownGuardContainers(router)`**

不同版本 Router 把守卫存放在不同名字的内部属性上，容器类型也不一样，因此逐个尝试：

```
beforeGuards / beforeResolveGuards / afterGuards
beforeHooks  / resolveHooks        / afterHooks
beforeEachHooks / beforeResolveHooks / afterEachHooks
```

`clearGuardContainer(value)` 适配了多种容器：Array（`length = 0`）、Set / Map（`clear()`）、带 `list` 数组的对象、带 `reset()` 方法的对象。

**跳转层 —— `makeRouterJumpBlocker()` / `makeBrowserJumpBlocker()`**

覆盖 8 个入口：

- `router.push` / `router.replace` → 返回 `Promise.resolve(false)` 表示「跳转被拒绝」。**必须返回 Promise**，因为调用方普遍写 `await router.push(...)`，返回 `undefined` 会让调用链出错。
- `router.go`、`history.back` / `forward` / `go` → 直接吞掉
- `Location.prototype.assign` / `replace` → 改**原型**，一次覆盖所有 location 实例
- `window.close` → 阻止页面自行关闭

> `Location.prototype` 的改写包在 try/catch 中：部分页面对它加了属性描述符保护，改写会抛异常，此时跳过即可，不影响其他拦截。

#### ③ 防检测：把替身函数伪装成原生

`maskToString(fn, name)` 重写替身函数的 `toString()`，让它返回 `function beforeEach() { [native code] }`。有些站点会检测关键 API 是否被改写，这一步降低被识别的概率。

#### ④ 原型级接管 —— `patchVueRouterPrototype()`

逐实例接管只能处理**已存在**的 Router。若页面存在全局的 `window.VueRouter`（UMD 构建），直接改写它的 `prototype`，就把拦截提前到了「实例诞生之前」，覆盖之后 `new` 出来的所有实例。用 `WeakSet`（`patchedObjects`）保证原型只被改写一次。

#### ⑤ 持续发现「后创建」的 Router

SPA 常按需加载路由或延迟挂载组件，一次性扫描覆盖不全，因此采用「多次扫描 + DOM 变更监听」的组合：

```
document_start 注入
├─ 立即执行不依赖 DOM 的拦截：Array.prototype.push 钩子、浏览器跳转拦截、上报一次状态
└─ DOM 就绪后
   ├─ scanRouters()                        首次全量扫描
   ├─ MutationObserver(childList + subtree) 文档树变更 → 80ms 防抖后重扫
   └─ [50,150,350,800,1500,3000,6000]ms    七个时间点兜底重扫
```

`scanRouters()` 自身还有三重保护：

- **BFS 遍历**：先在浅层命中，尽快完成接管
- `visited` Set：Vue 会在元素上挂引用形成环，避免重复访问
- **最多扫描 8000 个节点**：超大页面不会长时间占用主线程

#### ⑥ `Array.prototype.push` 钩子：兜底防线

部分 Router 版本会把守卫直接 `push` 进内部数组，绕过被替换的方法。所以 hook 了 `Array.prototype.push`：**只有当被推入的是函数、且调用栈中出现 `beforeEach` / `beforeResolve` / `afterEach` 时才拦截**，其余情况一律放行 —— 避免误伤页面正常的数组操作。调用栈读取失败时同样放行。

#### ⑦ 重入保护

同一页面（含 iframe）可能被注入多次。用 `Object.defineProperty(window, '__VUECRACK_ALL_IN_INSTALLED__', { configurable: false, writable: false })` 打标记，页面侧无法覆盖后重复注入。

#### ⑧ 状态回显

`all-in.ts` 维护一份统计（`routersPatched` / `guardRegistrationBlocked` / `routerJumpBlocked` / `browserJumpBlocked` / `lastEvent`），每次拦截事件后通过 `postMessage` 上报，popup 里显示为「已注入 · 守卫 N · Router N · 浏览器 N」。

### 4. API 端点提取

**目标**：从三个数据源汇总接口清单，标注哪些已被真实调用，并探测 sourcemap 泄露。

**实现于** `src/extension/api-extractor.ts`（提取）+ `src/utils/apiExport.ts`（导出）+ `src/components/ApiPanel.vue`（展示）

按需注入 —— 只有点击「提取API」时才把脚本注入页面；注入 URL 后拼 `?t=时间戳` 绕过浏览器缓存，以支持反复提取。

#### ① 三个数据源

| 数据源 | 关键函数 | 可信度 |
| --- | --- | --- |
| performance 中的真实请求 | `collectLiveApiCalls()` | **最高**（确定存在且已被调用） |
| 外部 JS 源码 | `collectScriptSources()` + `extractFromText()` | 中 |
| 页面内联脚本 | `collectInlineScripts()` | 中 |
| sourcemap 泄露 | `findSourceMappingURL()` + `checkSourceMap()` | —— |

**执行顺序是敏感的**：`run()` 必须在**自身发出任何 fetch 之前**先快照 performance，否则提取器自己的请求会混入结果。

#### ② 收集 JS 资源：为什么不能只看 DOM

- `document.querySelectorAll('script[src]')` —— 只能拿到当前 DOM 里还留着的脚本
- `performance.getEntriesByType('resource')` —— **懒加载 chunk 的救命稻草**：这类脚本动态插入执行后可能已被移除，DOM 查不到，但 performance 有记录

两者合并去重，最多取 **80 个**（`MAX_SCRIPTS`）以控制耗时。

#### ③ 静态提取与降噪

`extractFromText()` 用三条正则匹配引号内的字符串：

1. 带前导斜杠：`"/api/user/list"`
2. **无前导斜杠的相对路径**：`"sys/User/userLogin"`（axios 配了 `baseURL` 时的常见写法）
3. 完整 URL：`"https://api.example.com/v1/xxx"`（跨域后端）

难点在**降噪** —— webpack 的模块标识（如 `"aya4/Dd8w"`）和相对路径长得一模一样。`isApiLikeRelativePath()` 的判断办法是：若所有分段都是 **1~6 位短标识**，且不含 API 前缀词或动作词，就判为模块名噪音。

其他降噪规则（`isApiLikePath()`）：

| 规则 | 排除的东西 |
| --- | --- |
| 长度必须在 4~200 之间 | 过短或过长的碎片 |
| 以 `//` 开头 | 协议相对 URL |
| 命中静态扩展名 | `.js` `.css` `.png` `.map` `.woff2` … |
| 分段少于 2 段 | 页面路由（如 `/login`） |
| 命中静态目录前缀 | `assets` `static` `dist` `vendor` `lib` … |
| 必须命中 API 前缀词或动作词 | 其余全部噪音 |

- API 前缀词：`api` `v1` `rest` `gateway` `auth` `user` `admin` `graphql` 等
- 动作词：`get` `list` `create` `update` `delete` `login` `export` `upload` `page` `count` 等

#### ④ 串行拉取 + 超时

外部 JS 逐个**串行**拉取分析（不是并行）：既便于上报精确进度（「正在分析JS 3/12：app.js」），也避免对目标站造成并发压力。

每个请求用 `AbortController` 做 **8 秒**（`FETCH_TIMEOUT`）超时；用 `credentials: 'omit'` 不携带 Cookie，减少对目标侧的副作用。

单个文件失败（跨域受限等）不影响整体流程，只记入 `failedScripts`，界面显示「失败 N 个（跨域受限）」。

#### ⑤ Sourcemap 泄露探测

从 JS 源码尾部解析 `//# sourceMappingURL=...`，再请求该 `.map` 文件。**只认响应头为 JSON / JavaScript 的情况** —— 否则会把 SPA 的兜底 HTML（未命中时返回 index.html）误判成泄露。内联的 `data:` 形式直接跳过。

#### ⑥ 把「已调用」标记出来

`staticApis` 中的每个端点都会与真实请求列表比对，判断是否已被调用。比对前先归一化 —— 源码里写的是 `/api/user/${id}`，实际请求是 `/api/user/123`：`cleanTemplatePath()` 去掉 `${...}` / `:param` / `{...}` 得到前缀，再按「完全相等或前缀匹配」判断。

结果就是界面上高亮的 **「未调用」端点** —— 这些是未授权测试的优先目标。

#### ⑦ 模板参数的两种处理（不能混淆）

| 函数 | 用途 | `${id}` 变成 |
| --- | --- | --- |
| `cleanTemplatePath()` | 判断是否已调用 | 空字符串（只留前缀） |
| `fillTemplateParams()` | 生成可直接请求的 URL | `1` |

`buildFullUrl()` 据此生成完整 URL：输入是完整 URL 时只替换 pathname 上的模板参数；输入是相对路径时补前导斜杠后拼上 `location.origin`。

#### ⑧ 导出

`src/utils/apiExport.ts` 负责：

- `collectAllApiFullUrls()`：全部端点去重，可直接粘进 Burp Intruder / Scanner
- `buildApiExportText()`：生成 TXT（含完整 URL、调用状态、来源文件、未调用清单、sourcemap 泄露清单）
- `buildApiExportFilename()`：`vuecrack-api-<host>-<yyyyMMdd-HHmmss>.txt`
- `downloadTextFile()`：Blob + `a[download]`，不需要额外权限

### 5. 分析结果缓存

**目标**：同一 URL 第二次打开 popup 时秒出结果，避免重复分析。

**实现于** `src/utils/storage.ts`

用 `localStorage` 存两份数据，职责不同：

| 键前缀 | 内容 | 上限 |
| --- | --- | --- |
| `vuecrack_analysis_cache:` | 按 **URL** 缓存整份路由分析结果 | 15 条 |
| `vuecrack_last_opened_route:` | 按 **origin** 记「上次打开过哪条路由」 | 50 条 |

超出上限时按 `savedAt` 淘汰最旧的（`pruneByLimit`）。

路由记忆用 **origin** 而不是完整 URL 作键 —— 这样同站点的不同页面之间共享记忆，切换页面后仍然能高亮之前访问过的那条路由。

`readLastOpenedRoute()` 还兼容早期版本的纯字符串格式（那时没有包 JSON），解析失败就原样返回。

### 6. popup 侧的实现（Vue）

**目标**：把「取数据 → 渲染 → 交互」清晰分层。

**实现于** `src/`

| 层 | 目录 | 职责 |
| --- | --- | --- |
| 展示层 | `src/components/*.vue` | 纯渲染，不含业务规则 |
| 状态层 | `src/composables/*.ts` | 模块级单例状态 + 与 `chrome.*` API 的交互 |
| 逻辑层 | `src/utils/*.ts` | 纯函数，零 Vue 依赖 |

**为什么 composable 的状态定义在模块作用域**：popup 同时只有一个实例。若状态写在 `useXxx()` 函数体内，每个组件调用都会拿到一份互不同步的副本；定义在模块作用域后，`useXxx()` 只是取用同一份状态的入口。

**为什么要状态机**：原来是把 HTML 字符串塞进容器，改成 `panelState`（`loading` / `error` / `no-vue` / `no-router` / `ready`）后由模板按状态渲染，不再需要手工拼字符串。

**为什么删掉了 `escapeHtml()`**：Vue 的插值 `{{ }}` 与属性绑定（`:title` / `:data-*`）会自动转义，手工转义反而会导致双重转义。

### 7. 消息过滤：防止过期结果覆盖界面

**目标**：点击「打开」跳转后，旧页面可能还会回传分析结果，不能让它覆盖新页面的数据。

**实现于** `src/composables/useRouterAnalysis.ts` + `src/App.vue`

两条过滤规则：

1. `sender.tab.id !== currentTabId` → 直接丢弃（消息不是来自当前标签页）
2. 存在待跳转目标（`pendingNavigationUrl`）且消息来源页 URL 与它不一致 → 丢弃（旧页面的过期消息）

收到有效结果或错误后清空 `pendingNavigationUrl`，恢复正常接收。

---

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 获取当前标签页信息 |
| `scripting` | 动态注册梭哈模式内容脚本 |
| `storage` | 存储梭哈模式站点白名单 |
| `tabs` | 查询标签页、跳转路由、监听页面更新 |
| `host_permissions: <all_urls>` | 在任意目标站点注入检测与提取脚本 |
| `web_accessible_resources` | 允许页面加载 `detector.js` 与 `api-extractor.js` |

---

## 功能总览

以下是各功能的完整描述（从 README 移入，作为后续实现章节的总纲）。

- **Vue 框架与版本检测** —— 识别 Vue 2 / Vue 3 根实例与版本号，兼容延迟挂载的页面。
- **路由枚举与 URL 生成** —— 兼容 Vue Router 2/3/4 的多种数据来源，递归展开嵌套路由，按 Hash / History 模式生成可直接访问的完整 URL。
- **梭哈模式（路由守卫绕过）** —— 在 `document_start` 抢跑，拦截守卫注册、清空存量守卫、阻断跳转，绕过前端路由鉴权。按站点白名单生效。
- **API 端点提取** —— 汇总「页面已发出的真实请求」「JS 源码静态提取」「Sourcemap 泄露探测」三类数据，标注未调用端点作为优先测试目标，支持导出 TXT / JSON。
- **结果缓存** —— 分析结果与上次访问路由本地缓存，重复打开秒出结果。
