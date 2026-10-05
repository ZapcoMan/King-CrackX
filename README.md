# King-CrackX

> 本项目基于 [King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git) 进行的**二次开发**。

适用于 Chrome / Chromium 的浏览器扩展（Manifest V3），面向**授权渗透测试与前端安全评估**：自动识别目标站点的 Vue / React 框架、枚举全部路由并生成可访问的完整 URL、绕过前端路由守卫（Vue Router / React Router）、从源码与真实请求中提取 API 端点，并基于分析结果自动执行安全审计、导出 Markdown 报告。

## 功能特性

- **前端框架与版本检测** —— 自动识别 Vue（2 / 3）与 React（17 / 18 / 19），输出版本号，兼容延迟挂载的 SPA。
- **路由枚举与完整 URL 生成** —— Vue 兼容 Router 2/3/4；React 侧多路由库适配：React Router（v6.4+ / v7 data router、v4–v7 声明式）、TanStack Router、Next.js（Pages / App），并按命中结果显示「路由库」名称；无法静态枚举时以页面锚点链接兜底。按 Hash / History 模式与基础路径生成可点击的完整 URL。
- **梭哈模式（绕过前端路由守卫）** —— `document_start` 抢跑强制接管 Router：Vue 清除守卫并拦截 `push/replace`，React 拦截 `router.navigate` / TanStack `navigate` / Next.js `router.push·replace`；按站点白名单生效，实时回显拦截统计。
- **API 端点提取与导出** —— 汇总真实请求 / JS 源码静态提取 / Sourcemap 探测三类数据，标注未调用端点，可复制 JSON 或导出 TXT。
- **安全审计** —— 复用上述结果，自动检测敏感 API、裸露路由与 Sourcemap 泄露，生成风险评级与修复建议，可导出综合 Markdown 报告。
- **分析结果缓存** —— 按 URL 缓存分析结果、按站点记忆已打开的路由，重复打开秒出。
- **多主题切换** —— 浅色 / 深色 / 跟随系统（默认）/ 极客。

各功能的完整实现原理见 [功能实现原理](docs/implementation.md)，安全审计详见 [安全审计功能说明](docs/security-audit.md)。

## 工作原理

扩展同时运行在**三个 JavaScript 世界**（扩展后台 / 内容脚本 ISOLATED / 页面主世界 MAIN），`content.ts` 作为传话筒完成 `chrome.*` 与页面框架（Vue / React）内部对象之间的桥接。完整说明见 [整体架构：三世界模型](docs/architecture.md)。

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
│   │   ├── ApiPanel.vue              #   API 提取进度、结果展示、导出与复制
│   │   ├── SecurityPanel.vue         #   安全审计触发、风险摘要与发现项、报告导出
│   │   └── SettingsPanel.vue         #   主题切换等设置
│   ├── composables/                  # 状态层（模块级单例）
│   │   ├── useCurrentTab.ts          #   当前标签页
│   │   ├── useAllInMode.ts           #   梭哈模式开关 + 白名单写入
│   │   ├── useRouterAnalysis.ts      #   路由分析结果、缓存、URL 列表状态机
│   │   ├── useApiExtract.ts          #   API 提取进度/结果/导出
│   │   ├── useSecurityAudit.ts       #   安全审计编排与报告导出（消费前几者结果）
│   │   └── useTheme.ts               #   主题切换（light/dark/system/geek）
│   ├── utils/                        # 纯逻辑层（不含 Vue 依赖）
│   │   ├── url.ts                    #   URL 归一化、路由去重
│   │   ├── routeUrls.ts              #   路由 → 完整 URL 的拼接规则
│   │   ├── storage.ts                #   localStorage 缓存 + 白名单归一化
│   │   ├── apiExport.ts              #   API 结果收集、TXT 导出、剪贴板
│   │   ├── securityAudit.ts          #   审计规则引擎（敏感 API / 路由权限 / Sourcemap / 风险评级）
│   │   ├── securityReport.ts         #   全模块综合 Markdown 报告生成与下载
│   │   └── dom.ts                    #   当前路由滚动定位
│   ├── styles/popup.css              # 全局样式
│   └── extension/                    # ★ 扩展注入脚本（无视图层，不使用 Vue）
│       ├── types.d.ts                #   全局类型契约（Vue/React 内部结构、消息协议）
│       ├── background.ts             #   Service Worker：按站点白名单动态注册/注销梭哈模式脚本
│       ├── content.ts                #   内容脚本（ISOLATED world）：注入页面脚本、转发消息
│       ├── detector.ts               #   注入页面（MAIN world）：Vue/React 自动检测 + 多路由库枚举 + 温和守卫清除
│       ├── all-in.ts                 #   注入页面（MAIN world）：document_start 前置强拦截（Vue Router + React Router/TanStack/Next.js）
│       └── api-extractor.ts          #   注入页面（MAIN world）：真实请求 + 静态端点提取 + Sourcemap 探测
├── index.html                        # Vite 入口（= 扩展弹窗页面）
├── vite.config.ts                    # 统一构建配置（popup + 5 个注入脚本）
├── tsconfig.json                     # 类型检查配置
├── docs/                             # 补充文档（见下方「文档」索引，含 legacy/ 早期版本存档）
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

## 安装

```bash
npm install --include=dev
npm run build
```

构建产物在 `dist/`。打开 `chrome://extensions/`，开启开发者模式，点「加载已解压的扩展程序」，选择 **`dist/`** 目录。

> 完整步骤、命令与构建约束见 [开发注意事项](docs/development.md)。

## 使用

1. 打开目标页面，点击扩展图标，自动识别框架（Vue / React）并分析路由。
2. 在**完整URL列表**中复制或直接打开目标路由。
3. 需要绕过路由守卫时，打开**梭哈模式**开关并刷新页面（仅对当前站点生效）。
4. 点击**提取API**获取端点清单，可复制或导出。
5. 在**安全审计**面板点击「开始审计」查看风险报告，可导出/复制整合全部模块数据的 Markdown 综合报告。

> 推荐流程：先路由分析与 API 提取，再执行安全审计（详见 [安全审计功能说明](docs/security-audit.md)）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [整体架构：三世界模型](docs/architecture.md) | 扩展的运行环境与消息链路 |
| [功能实现原理](docs/implementation.md) | 各功能怎么实现、需要哪些权限 |
| [安全审计功能说明](docs/security-audit.md) | 审计维度、检测规则、报告示例与使用流程 |
| [开发注意事项](docs/development.md) | 技术栈、项目结构、构建约束 |
| [变更日志](docs/changelog.md) | 版本变更记录 |

## 免责声明

本项目仅供 **安全研究与授权渗透测试** 使用。使用者应确保已获得目标系统的**明确书面授权**，并遵守当地法律法规。任何未经授权的测试、攻击或数据获取行为均与本项目作者无关，由使用者自行承担全部责任。

## 致谢

- 上游项目：[King-Crack](https://github.com/chaojiwudichoubie1-arch/King-Crack.git)
- 本项目基于上游进行二次开发，在原功能基础上进行了重构与增强。
- 最初的纯 JavaScript 版本说明：[`docs/legacy/original-version.md`](docs/legacy/original-version.md)
