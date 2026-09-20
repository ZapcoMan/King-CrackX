# King-CrackX

> 本项目基于 [King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git) 进行的**二次开发**。

King-CrackX 是一个 Chrome / Chromium 浏览器扩展（Manifest V3），面向**授权渗透测试与前端安全评估**场景。它可以检测目标站点是否使用 Vue 框架、读取并强制接管 Vue Router（绕过前端路由守卫）、枚举全部路由并生成可直接访问的完整 URL，同时从 JS 源码与实际请求中提取 API 端点，为后续的接口测试提供目标清单。

## 功能特性

- **Vue 框架与版本检测** —— 识别 Vue 2 / Vue 3 根实例与版本号，兼容延迟挂载的页面。
- **路由枚举与 URL 生成** —— 兼容 Vue Router 2/3/4 的多种数据来源，递归展开嵌套路由，按 Hash / History 模式生成可直接访问的完整 URL。
- **梭哈模式（路由守卫绕过）** —— 在 `document_start` 抢跑，拦截守卫注册、清空存量守卫、阻断跳转，绕过前端路由鉴权。按站点白名单生效。
- **API 端点提取** —— 汇总「页面已发出的真实请求」「JS 源码静态提取」「Sourcemap 泄露探测」三类数据，标注未调用端点作为优先测试目标，支持导出 TXT / JSON。
- **结果缓存** —— 分析结果与上次访问路由本地缓存，重复打开秒出结果。

---

## 技术栈

一个标准的 **Vue 3 + Vite + TypeScript** 项目。

| 部分 | 技术 | 构建方式 |
| --- | --- | --- |
| **popup 弹窗** | **Vue 3**（SFC + `<script setup>` + 组合式 API） | Vite 打包 → `dist/index.html` + `dist/assets/*` |
| **5 个注入脚本** | TypeScript | Vite（Rolldown）打包为**自包含 IIFE 普通脚本** → `dist/*.js` |

- **只有一个构建工具：Vite。** 一条 `npm run build` 产出全部内容。
- popup 的脚本/样式引用由 Vite 在构建时自动写进 `dist/index.html`，**源码里不写 `<script src>`**，因此不存在「引用的文件不存在」这类问题。
- 扩展的静态资源（`manifest.json`、`icons/`）放在 `public/`，由 Vite 原样复制进 `dist/`。
- 产物刻意保持**不压缩**（`minify: false`），便于安全审计时直接审阅扩展实际执行的代码。

---

## 安装

### 0. 构建（首次使用或修改源码后必须执行）

> 仓库里没有可直接加载的 `.js`，浏览器无法直接运行源码，因此**必须先构建**。

```bash
npm install --include=dev   # 必须带 --include=dev：部分环境设置了 NODE_ENV=production 会跳过 devDependencies
npm run build               # 一条命令产出全部：popup + 5 个注入脚本 + 静态资源
npm run dev                 # Vite 开发服务器（调试 popup 界面用）
npm run typecheck           # 类型检查，不产出文件
```

构建完成后会生成 `dist/` 目录，其中包含完整的扩展文件。

### 1. 加载扩展

1. 下载或克隆本项目到本地：
   ```bash
   git clone https://github.com/chaojiwudichoubie1-arch/King-Crack.git
   ```
2. 打开 Chrome / Edge，访问 `chrome://extensions/`。
3. 右上角开启 **开发者模式**。
4. 点击 **加载已解压的扩展程序**，选择本项目的 **`dist/` 目录**（不是项目根目录）。
5. 打开目标站点，点击工具栏中的 King-CrackX 图标即可使用。

> 最初版本（纯 JS，无需构建，直接加载项目根目录）的安装方式见 [历史文档](docs/legacy/original-version.md)。

---

---

## 使用说明

| 步骤 | 操作 |
| --- | --- |
| 1 | 打开目标页面，点击扩展图标，自动开始 Vue 检测与路由分析 |
| 2 | 查看 **当前Vue版本** 与 **完整URL列表**，可按需切换「标准 / 带基础路径」模式 |
| 3 | 点击路由行的 **复制** / **打开** 进行单条验证，或 **复制所有URL** 批量导出 |
| 4 | 如需绕过前端路由守卫，打开 **梭哈模式** 开关并刷新页面（按站点生效） |
| 5 | 点击 **提取API** 获取端点清单，利用 **复制完整URL (Burp)** / **导出TXT** / **复制JSON** 输出结果 |

---

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
│   │   ├── AllInPanel.vue            #   梭哈模式开关与状态
│   │   ├── RouterPanel.vue           #   路由分析状态机（loading/error/no-vue/no-router/ready）
│   │   ├── UrlList.vue               #   完整 URL 列表、模式切换、复制/打开
│   │   └── ApiPanel.vue              #   API 提取结果、导出与复制
│   ├── composables/                  # 状态层（模块级单例）
│   │   ├── useCurrentTab.ts          #   当前标签页
│   │   ├── useAllInMode.ts           #   梭哈模式开关 + 白名单写入
│   │   ├── useRouterAnalysis.ts      #   路由分析结果、缓存、URL 列表状态机
│   │   └── useApiExtract.ts          #   API 提取进度/结果/导出
│   ├── utils/                        # 纯逻辑层（不含 Vue 依赖）
│   │   ├── url.ts                    #   URL 归一化、路由去重
│   │   ├── routeUrls.ts              #   路由 → 完整 URL 的拼接规则
│   │   ├── storage.ts                #   localStorage 缓存 + 白名单归一化
│   │   ├── apiExport.ts              #   API 结果收集、TXT 导出、剪贴板
│   │   └── dom.ts                    #   当前路由滚动定位
│   ├── styles/popup.css              # 全局样式
│   └── extension/                    # ★ 扩展注入脚本（无视图层，不使用 Vue）
│       ├── types.d.ts                #   全局类型契约（Vue/Router 内部结构、消息协议）
│       ├── background.ts             #   Service Worker：按站点白名单动态注册/注销梭哈模式脚本
│       ├── content.ts                #   内容脚本（ISOLATED world）：注入页面脚本、转发消息
│       ├── detector.ts               #   注入页面（MAIN world）：Vue 检测 + Router 分析 + 守卫清除
│       ├── all-in.ts                 #   注入页面（MAIN world）：document_start 前置强拦截
│       └── api-extractor.ts          #   注入页面（MAIN world）：API 端点静态提取 + Sourcemap 探测
├── index.html                        # Vite 入口（= 扩展弹窗页面）
├── vite.config.ts                    # 统一构建配置（popup + 5 个注入脚本）
├── tsconfig.json                     # 类型检查配置
├── docs/legacy/original-version.md   # 最初版本（纯 JS）的历史说明，仅作存档
├── package.json
├── dist/                             # ★ 构建产物 —— chrome://extensions 加载「这个」目录
│   ├── index.html                    #   弹窗页面（脚本/样式引用由 Vite 自动注入）
│   ├── assets/index.js|index.css     #   Vue 应用产物
│   ├── background.js                 #   ┐
│   ├── content.js                    #   │
│   ├── detector.js                   #   ├─ 注入脚本（自包含 IIFE）
│   ├── all-in.js                     #   │
│   ├── api-extractor.js              #   ┘
│   ├── manifest.json                 #   复制自 public/
│   └── icons/                        #   复制自 public/
└── README.md
```

> **重要**：
> 1. 项目根目录**不存在任何 `.js` 文件**，源码与产物完全分离。
> 2. `dist/` 里的一切都是**生成物**，不要手工编辑 —— 由 `npm run build` 完整重建。
> 3. 改弹窗界面编辑 `src/` 下的 `.vue` / `.ts`（除 `extension/`）；改注入脚本编辑 `src/extension/`。改完 `npm run build` 并在扩展页点「重新加载」。
> 4. `index.html` 中**看不到** `<script src=...>` —— 脚本与样式引用由 Vite 在构建时写入 `dist/index.html`。

---

---

## 文档

README 只保留项目层面的说明，技术细节已拆分到以下文档：

| 文档 | 内容 |
| --- | --- |
| [整体架构：三世界模型](docs/architecture.md) | 扩展运行在哪三个 JS 世界里、为什么必须这样设计、消息链路怎么走 |
| [功能实现原理](docs/implementation.md) | 每个功能是怎么用代码实现的（关键函数、设计取舍） |
| [开发注意事项](docs/development.md) | 改这套构建链路时必须遵守的约束、已踩过的坑 |
| [最初版本说明（存档）](docs/legacy/original-version.md) | 重构前纯 JavaScript 版本的说明与安装方式 |

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

---

## 免责声明

本项目仅供 **安全研究与授权渗透测试** 使用。使用者应确保已获得目标系统的**明确书面授权**，并遵守当地法律法规。任何未经授权的测试、攻击或数据获取行为均与本项目作者无关，由使用者自行承担全部责任。

---

## 致谢

- 上游项目：[King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git)
- 本项目基于上游进行二次开发，在原功能基础上进行了重构与增强。
- 最初的纯 JavaScript 版本说明：[`docs/legacy/original-version.md`](docs/legacy/original-version.md)
