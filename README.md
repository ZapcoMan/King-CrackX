# King-CrackX

> 本项目基于 [King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git) 进行的**二次开发**。

适用于 Chrome / Chromium 的浏览器扩展（Manifest V3），面向**授权渗透测试与前端安全评估**：检测目标站点的 Vue 框架、枚举全部前端路由并生成可访问的完整 URL、绕过前端路由守卫、从真实请求与 JS 源码中提取 API 端点、执行自动化安全审计并导出 Markdown 报告。

## 功能特性

### 🔍 Vue 检测与路由分析

- 自动检测页面是否使用 Vue（兼容 Vue 2 / 3），识别框架版本号；针对异步挂载的 SPA 提供多级延迟重试检测。
- 定位 Vue Router 实例（兼容 Router 2 / 3 / 4 及多种内部挂载形态），枚举全部路由（含嵌套子路由）。
- 分析 `router.options.base` 与页面链接前缀，识别子目录部署的基础路径。
- 分析结果按 URL 缓存到 localStorage，重开弹窗秒回上次结果，不闪加载态。

### 🔗 完整 URL 生成

- 自动区分 **Hash 模式**与 **History 模式**，把路由 path 拼接为可直接访问的完整 URL。
- 支持「标准 URL」与「带基础路径 URL」双模式切换：可信 base（`router.options.base`）优先，页面链接统计推测的候选 base 降级使用；站点级记忆用户选择。
- 每条路由支持复制、直接打开，并高亮当前所在路由；打开后自动过滤旧页面回传的过期结果。

### 🎰 梭哈模式（绕过前端路由守卫）

- 在 `document_start` 阶段抢先注入页面主世界，强制接管 Vue Router：
  - **守卫注册层**：拦截 `beforeEach` / `beforeResolve` / `afterEach`，并 hook `Array.prototype.push` 阻断守卫写入内部容器；
  - **存量守卫层**：清空各版本 Router 的守卫容器；
  - **跳转层**：拦截 `router.push/replace/go`、`history.*`、`location.assign/replace` 与 `window.close`，防止被踢回登录页。
- **按站点白名单生效**：开关只对当前 hostname 起作用，由 background 通过 `chrome.scripting` 动态注册/注销，不影响其他网站。
- 实时回传拦截统计（已接管 Router 数、守卫拦截数、跳转拦截数），弹窗内直接展示。

### 📡 API 端点提取

- **三数据源**提取后端接口：
  1. 页面已真实发出的 XHR / fetch 请求（来自 performance 条目，可信度最高）；
  2. JS 源码静态正则提取（外部脚本 + 懒加载 chunk + 内联脚本），支持绝对路径 / 相对路径（axios baseURL 场景）/ 完整 URL 三种形态；
  3. `sourceMappingURL` 指向的 Sourcemap 可达性探测（源码泄露检测）。
- 内置多层降噪：静态资源扩展名、静态目录、页面路由、webpack 模块名等噪音统一过滤。
- 静态端点自动标记「是否已被页面调用」，模板参数（`${id}` / `:id` / `{id}`）自动识别并填充为可用 URL。
- 结果支持一键复制全部完整 URL、复制 JSON、导出 TXT；带实时进度显示（正在分析 JS n/N）。

### 🛡️ 安全审计

- 复用路由分析与 API 提取的结果，**零额外采集**，执行四个维度的自动审计：
  1. 敏感 API 检测（管理接口、删除操作、支付财务、系统配置等 12 类关键词，四级风险评级）；
  2. 路由权限配置分析（识别 meta 中 `auth*` / `role*` / `perm*` 字段，找出缺少保护的路由）；
  3. 未授权访问路径识别与风险排序；
  4. Sourcemap 泄露风险评估。
- 生成综合风险评级（critical / high / medium / low / safe）与针对性修复建议。
- 支持导出**整合全部模块数据**（梭哈统计 + 路由分析 + API 清单 + 审计报告）的 Markdown 综合报告，可下载或复制到剪贴板。

### ⚙️ 其他

- 多主题切换：浅色 / 深色 / 跟随系统 / 极客（默认）。
- 所有注入脚本构建产物**不压缩**，可直接审阅扩展实际执行的代码。

各功能的完整实现原理见 [功能实现原理](docs/implementation.md)。

## 工作原理

三个功能模块共享同一套「三世界」消息架构：

```
popup（Vue 弹窗） ⇄ content.js（ISOLATED world 桥接） ⇄ 注入脚本（MAIN world）
 chrome.runtime          window.postMessage 转发          访问 Vue 内部对象
```

- `detector.js` / `api-extractor.js` / `all-in.js` 必须运行在页面 MAIN world 才能访问 Vue / Router 内部结构，但那里无法使用 `chrome.*` API，因此由 `content.js` 专职做两侧消息转发。
- popup 不等待消息回调，所有结果（含实时进度）均由页面脚本主动逐级推送。
- 梭哈模式需要在页面业务代码执行前抢跑，因此不写死在 manifest 中，而由 `background.js` 依据站点白名单通过 `chrome.scripting.registerContentScripts` 动态注册。

整体架构详见 [三世界模型](docs/architecture.md)。

## 项目结构

```
King-CrackX/                          # 标准 Vue 3 + Vite 项目布局
├── public/                           # 静态资源（Vite 约定：原样复制进 dist）
│   ├── manifest.json                 #   MV3 扩展清单（default_popup 指向 index.html）
│   └── icons/icon256.png             #   扩展图标
├── src/
│   ├── main.ts                       # Vue 应用入口（createApp）
│   ├── App.vue                       # 根组件：组装面板 + 注册 chrome.* 事件 + 启动流程
│   ├── env.d.ts                      # .vue 模块声明
│   ├── components/                   # 展示组件
│   │   ├── AllInPanel.vue            #   梭哈模式开关与拦截统计
│   │   ├── RouterPanel.vue           #   路由分析状态机（loading/error/no-vue/no-router/ready）
│   │   ├── UrlList.vue               #   完整 URL 列表、模式切换、复制/打开
│   │   ├── ApiPanel.vue              #   API 提取进度、结果展示、导出与复制
│   │   ├── SecurityPanel.vue         #   安全审计触发、风险摘要与发现项展示、报告导出
│   │   └── SettingsPanel.vue         #   主题切换等设置
│   ├── composables/                  # 状态层（模块级单例）
│   │   ├── useCurrentTab.ts          #   当前标签页
│   │   ├── useAllInMode.ts           #   梭哈模式开关 + 白名单写入 + 拦截统计
│   │   ├── useRouterAnalysis.ts      #   路由分析结果、缓存、URL 列表状态机
│   │   ├── useApiExtract.ts          #   API 提取进度/结果/导出
│   │   ├── useSecurityAudit.ts       #   安全审计编排与报告导出（消费前三者结果）
│   │   └── useTheme.ts               #   主题切换（light/dark/system/geek）
│   ├── utils/                        # 纯逻辑层（不含 Vue 依赖）
│   │   ├── url.ts                    #   URL 归一化、路由去重
│   │   ├── routeUrls.ts              #   路由 → 完整 URL 的拼接规则（Hash/History × base 模式）
│   │   ├── storage.ts                #   localStorage 缓存 + 白名单归一化
│   │   ├── apiExport.ts              #   API 结果收集、TXT 导出、剪贴板
│   │   ├── securityAudit.ts          #   审计规则引擎（敏感 API / 路由权限 / Sourcemap / 风险评级）
│   │   ├── securityReport.ts         #   全模块综合 Markdown 报告生成与下载
│   │   └── dom.ts                    #   当前路由滚动定位
│   ├── styles/popup.css              # 全局样式
│   └── extension/                    # ★ 扩展注入脚本（无视图层，不使用 Vue）
│       ├── types.d.ts                #   全局类型契约（Vue/Router 内部结构、消息协议）
│       ├── background.ts             #   Service Worker：按站点白名单动态注册/注销梭哈模式脚本
│       ├── content.ts                #   内容脚本（ISOLATED world）：注入页面脚本、转发消息
│       ├── detector.ts               #   注入页面（MAIN world）：Vue 检测 + Router 分析 + 温和守卫清除
│       ├── all-in.ts                 #   注入页面（MAIN world）：document_start 前置强拦截（梭哈模式）
│       └── api-extractor.ts          #   注入页面（MAIN world）：真实请求 + 静态端点提取 + Sourcemap 探测
├── index.html                        # Vite 入口（= 扩展弹窗页面）
├── vite.config.ts                    # 统一构建配置（popup + 5 个注入脚本分别打包为自包含 IIFE）
├── tsconfig.json                     # 类型检查配置
├── docs/                             # 项目文档（另含 legacy/ 早期纯 JS 版本存档）
├── package.json
├── dist/                             # ★ 构建产物 —— chrome://extensions 加载「这个」目录
│   ├── index.html                    #   弹窗页面（脚本/样式引用由 Vite 自动注入）
│   ├── assets/index.js|index.css     #   Vue 应用产物
│   ├── background.js                 #   ┐
│   ├── content.js                    #   │
│   ├── detector.js                   #   ├─ 注入脚本（自包含 IIFE，未压缩便于审计）
│   ├── all-in.js                     #   │
│   ├── api-extractor.js              #   ┘
│   ├── manifest.json                 #   复制自 public/
│   └── icons/                        #   复制自 public/
└── README.md
```

## 安装

```bash
npm install --include=dev
npm run build
```

构建产物在 `dist/`。打开 `chrome://extensions/`，开启开发者模式，点「加载已解压的扩展程序」，选择 **`dist/`** 目录。

其他可用命令：`npm run dev`（Vite 开发服务器，仅弹窗 UI 调试）、`npm run typecheck`（TypeScript 类型检查）。

> 完整步骤与命令说明见 [开发注意事项](docs/development.md)。

## 使用

1. **打开目标页面**，点击扩展图标，弹窗自动检测 Vue 并分析路由。
2. 在**完整 URL 列表**中复制或直接打开目标路由；History 模式下可切换「标准 / 带基础路径」两种 URL。
3. 需要绕过路由守卫时，打开**梭哈模式**开关并刷新页面（仅对当前站点生效），弹窗实时显示拦截统计。
4. 点击**提取API**获取端点清单（真实请求 + 源码静态提取 + Sourcemap 探测），可复制或导出 TXT。
5. 点击**安全审计**，基于已有分析结果自动生成风险报告；可下载或复制整合全部模块数据的 Markdown 综合报告。
6. 在**设置**中切换界面主题。

> 推荐流程：先做路由分析与 API 提取，再执行安全审计，最后导出综合报告归档。

## 文档

| 文档 | 内容 |
| --- | --- |
| [整体架构：三世界模型](docs/architecture.md) | 扩展的运行环境与消息链路 |
| [功能实现原理](docs/implementation.md) | 各功能怎么实现、需要哪些权限 |
| [开发注意事项](docs/development.md) | 技术栈、项目结构、构建约束 |
| [变更日志](docs/changelog.md) | 版本变更记录 |

## 免责声明

本项目仅供 **安全研究与授权渗透测试** 使用。使用者应确保已获得目标系统的**明确书面授权**，并遵守当地法律法规。任何未经授权的测试、攻击或数据获取行为均与本项目作者无关，由使用者自行承担全部责任。

## 致谢

- 上游项目：[King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git)
- 本项目基于上游进行二次开发，在原功能基础上进行了重构与增强。
- 最初的纯 JavaScript 版本说明：[`docs/legacy/original-version.md`](docs/legacy/original-version.md)
