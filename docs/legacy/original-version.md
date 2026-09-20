> ⚠️ **历史存档文档**
>
> 这是 King-CrackX **最初版本（纯 JavaScript 实现）**的项目说明，仅作存档保留。
>
> 当时的使用方式是：仓库根目录直接放 6 个手写 `.js` 文件，用 `chrome://extensions`
> 加载**项目根目录**即可，**不需要任何构建步骤**。
>
> 当前项目已彻底重构为 **Vue 3 + Vite + TypeScript** 工程，目录结构和安装方式都已改变。
> 请以项目根目录的 **[README.md](../../README.md)** 为准。
>
> 功能层面两个版本是等价的（注入脚本的逻辑逐函数一致），差别只在工程结构与构建方式。

---

# King-CrackX

> 本项目基于 [King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git) 进行的**二次开发**。

King-CrackX 是一个 Chrome / Chromium 浏览器扩展（Manifest V3），面向**授权渗透测试与前端安全评估**场景。它可以检测目标站点是否使用 Vue 框架、读取并强制接管 Vue Router（绕过前端路由守卫）、枚举全部路由并生成可直接访问的完整 URL，同时从 JS 源码与实际请求中提取 API 端点，为后续的接口测试提供目标清单。

## 功能特性

### 1. Vue 框架与版本检测
- 广度优先遍历 DOM，识别 Vue 2（`__vue__`）与 Vue 3（`__vue_app__` / `_vnode`）根实例。
- 兼容延迟挂载场景，最多重试 3 次（0ms → 300ms → 600ms）。
- 提取 Vue 版本号（`__vue_app__.version`、`window.Vue.version`、Vue DevTools Hook 兜底）。

### 2. 路由信息枚举与 URL 生成
- 定位 `$router` 实例，兼容 Vue Router 4（`getRoutes()`）、Vue Router 2/3（`options.routes`）、`matcher` 及 `history.current.matched` 等多种来源。
- 递归展开 `children` 子路由，自动拼接父级路径，并按路径去重。
- 自动识别 **Hash 模式**（`#/`）与 **History 模式**，生成完整可访问 URL。
- 支持 **标准 / 带基础路径** 两种 URL 生成模式切换，基础路径来源优先级：
  1. Router 自身 `options.base` / `history.base`（可信）；
  2. 从页面 `<a href>` 链接中统计的高频公共前缀（候选，占比 > 60% 时启用）。
- 每条路由支持一键**复制**与**打开**，并高亮上次访问过的路由。

### 3. 梭哈模式（强制注入路由守卫绕过）
通过在 `document_start` 阶段以 `world: "MAIN"` 注册 `all-in.js`，在页面框架代码执行前完成前置注入：

- **守卫注册拦截**：接管 `beforeEach` / `beforeResolve` / `afterEach`，并 hook `Array.prototype.push`，阻止新的守卫被注册。
- **清空已有守卫**：清空 `beforeGuards` / `beforeResolveGuards` / `afterGuards` / `beforeHooks` 等已知守卫容器（支持 Array / Set / Map）。
- **跳转拦截**：阻断 `router.push` / `router.replace` / `router.go`、`history.back/forward/go`、`location.assign/replace`、`window.close`，防止被踢回登录页。
- **鉴权元信息改写**：将 `meta` 中包含 `auth` / `login` / `permission` 且为真的字段置为 `false`。
- **原型级接管**：patch `window.VueRouter.prototype`，覆盖后续创建的 Router 实例。
- **持续扫描**：`MutationObserver` + 多时间点（50ms ~ 6000ms）扫描，动态接管后创建的 Router。
- **原生伪装**：被替换的函数通过 `toString` 伪装为 `[native code]`，降低被检测风险。
- **状态回显**：实时统计已接管 Router 数、拦截守卫数、Router 跳转拦截数、浏览器跳转拦截数。

> 梭哈模式**按站点白名单生效**（以 hostname 为粒度存储于 `chrome.storage.local`），开启后需刷新页面才生效。

### 4. API 端点提取
点击「提取API」后按需注入 `api-extractor.js`，从三个数据源汇总接口：

| 数据源 | 说明 |
| --- | --- |
| **实际调用接口** | 从 `performance.getEntriesByType('resource')` 中筛出 `xmlhttprequest` / `fetch` 的真实请求 |
| **JS 静态提取** | 拉取页面已加载 JS（含懒加载 chunk，最多 80 个）+ 内联脚本，正则匹配端点 |
| **Sourcemap 探测** | 解析 `sourceMappingURL` 并探测 `.map` 文件可达性，发现源码泄露 |

静态提取覆盖三种形态：
- 带前导斜杠的路径：`/api/user/list`
- 无前导斜杠的相对路径（axios 已配置 `baseURL` 场景）：`sys/User/userLogin`
- 跨域完整 URL：`https://api.example.com/v1/xxx`

并内置多重降噪策略：过滤静态资源扩展名（`.js`/`.css`/`.png` …）、过滤静态目录（`assets`/`static`/`dist` …）、过滤 webpack 短模块名噪音，仅保留含 API 前缀或动作词（`get`/`list`/`create`/`login` …）的路径。

**端点标注与利用辅助**：
- 标记每个端点是否**已被页面实际调用**，**未调用端点高亮为优先测试目标**。
- 识别模板参数 `:id` / `${id}` / `{id}`，并自动填充为 `1` 生成可直接请求的完整 URL。
- 记录每个端点的来源 JS 文件（最多 5 个）。

**导出能力**：
- 复制完整 URL（去重，可直接粘贴到 Burp Suite Intruder / Scanner）
- 导出 TXT（含完整 URL、调用状态、来源、未调用清单、Sourcemap 泄露清单）
- 复制 JSON

### 5. 分析结果缓存
- 基于 `localStorage` 按 URL 缓存路由分析结果（最多 15 条）与上次访问路由（最多 50 条），页面刷新或跳转后秒出结果，避免重复分析。

## 安装

1. 下载或克隆本项目到本地：
   ```bash
   git clone https://github.com/chaojiwudichoubie1-arch/King-Crack.git
   ```
2. 打开 Chrome / Edge，访问 `chrome://extensions/`。
3. 右上角开启 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择本项目根目录。
5. 打开目标站点，点击工具栏中的 King-CrackX 图标即可使用。

## 使用说明

| 步骤 | 操作 |
| --- | --- |
| 1 | 打开目标页面，点击扩展图标，自动开始 Vue 检测与路由分析 |
| 2 | 查看 **当前Vue版本** 与 **完整URL列表**，可按需切换「标准 / 带基础路径」模式 |
| 3 | 点击路由行的 **复制** / **打开** 进行单条验证，或 **复制所有URL** 批量导出 |
| 4 | 如需绕过前端路由守卫，打开 **梭哈模式** 开关并刷新页面 |
| 5 | 点击 **提取API** 获取端点清单，利用 **复制完整URL (Burp)** / **导出TXT** / **复制JSON** 输出结果 |

## 项目结构

```
King-CrackX/
├── manifest.json      # 扩展清单（MV3），声明权限、内容脚本与可访问资源
├── background.js      # Service Worker：按站点白名单动态注册/注销梭哈模式脚本
├── content.js         # 内容脚本（ISOLATED world）：注入页面脚本、转发消息
├── detector.js        # 注入页面（MAIN world）：Vue 检测 + Router 分析 + 守卫清除
├── all-in.js          # 注入页面（MAIN world）：document_start 前置强拦截
├── api-extractor.js   # 注入页面（MAIN world）：API 端点静态提取 + Sourcemap 探测
├── popup.html         # 弹窗 UI 与样式
├── popup.js           # 弹窗逻辑：结果渲染、缓存、导入导出
└── icons/             # 扩展图标
```

### 通信架构

```
popup.js  ──chrome.runtime.sendMessage──▶  content.js
                                              │  注入 <script src=chrome.runtime.getURL(...)>
                                              ▼
                                    detector.js / all-in.js / api-extractor.js  (MAIN world)
                                              │  window.postMessage
                                              ▼
                                          content.js  ──▶  popup.js
```

页面脚本运行在 `MAIN world` 以直接访问 Vue 内部对象，`content.js` 作为桥接层在 `ISOLATED world` 中完成与扩展后台的消息转发。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 获取当前标签页信息 |
| `scripting` | 动态注册梭哈模式内容脚本 |
| `storage` | 存储梭哈模式站点白名单 |
| `tabs` | 查询标签页、跳转路由、监听页面更新 |
| `host_permissions: <all_urls>` | 在任意目标站点注入检测与提取脚本 |
| `web_accessible_resources` | 允许页面加载 `detector.js` 与 `api-extractor.js` |

## 免责声明

本项目仅供 **安全研究与授权渗透测试** 使用。使用者应确保已获得目标系统的**明确书面授权**，并遵守当地法律法规。任何未经授权的测试、攻击或数据获取行为均与本项目作者无关，由使用者自行承担全部责任。

## 致谢

- 上游项目：[King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git)
- 本项目基于上游进行二次开发，在原功能基础上进行了重构与增强。-
