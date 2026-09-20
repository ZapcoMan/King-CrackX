# 开发注意事项

> 本文档是 [README](../README.md) 的补充材料，记录改动这套构建链路时**必须遵守的约束**，
> 以及几个已经踩过的坑。

以下几条都是这套构建链路里**必须遵守否则会出问题**的约束：

### 1. `src/extension/**` 禁止 `import` / `export`

这几个文件必须保持「普通脚本」形态 —— `content_scripts`、MAIN world 注入脚本、`service_worker` 都不支持 ES Module。一旦写成模块，加载时直接失败。共享类型统一写在 `src/extension/types.d.ts` 的环境声明里。

### 2. 产物中不能出现 `"use strict"`

这 5 个脚本原本是**非严格脚本**，加上严格模式会改变运行时语义（典型差异：把方法解构出来单独调用时 `this` 的处理不同）。

注意 `tsconfig.json` 的 `strict: true` **隐含** `alwaysStrict`，esbuild 会据此注入 `"use strict"`。项目里已显式设 `alwaysStrict: false`，但转译层仍可能注入，因此 `vite.config.ts` 里还有一个 `stripUseStrictPlugin` 兜底移除。

改完请检查：

```bash
grep '"use strict"' dist/*.js      # 应该没有任何输出
```

### 3. CSP 限制：不能用 `eval` / `new Function`

MV3 扩展页面的 CSP 禁止动态代码求值，所以 Vue 必须是 **runtime-only**（由 `@vitejs/plugin-vue` 预编译模板）。改完建议检查：

```bash
grep -E 'new Function|eval\(' dist/assets/index.js   # 应该没有任何输出
```

### 4. 图标必须用 `:src` 动态绑定

```vue
<!-- 错误：Vite 会把静态 src 当「模块引用」去源码目录解析，构建直接失败 -->
<img src="/icons/icon256.png">

<!-- 正确：图标是扩展运行期资源，不参与打包 -->
<img :src="ICON_URL">
```

### 5. tree-shaking 的实际行为

注入脚本的产物需要能**逐行审计**，因此 `vite.config.ts` 里对子构建设了 `treeshake: false`，意图是保留源码中的全部函数。

但当前打包器（**Rolldown**，Vite 8 起替代 Rollup）对该选项支持不完整 —— `detector.ts` 中**从未被调用**的 `cleanUrl` 仍会被移除。这不影响功能（它本来就是死代码），但审计时需要注意：**产物里缺少的某个函数，先确认它在源码中是否真的被调用过**。

### 6. 已知的、可接受的产物差异

做等价性比对时，以下差异属正常现象，均不影响功能：

| 现象 | 原因 |
| --- | --- |
| `function traverse(` 在产物中找不到 | 打包器把**块级**函数声明提升为变量（`let traverse2 = function(){}; var traverse = traverse2;`），递归调用与外部绑定都保留 |
| `detector.ts` 的 `cleanUrl` 在产物中消失 | 它是死代码（源码中也从未被调用过），被 tree-shaking 移除 |

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

## 常用命令

```bash
npm install --include=dev   # 必须带 --include=dev
npm run build               # 产出全部：Vue popup + 5 个注入脚本 + 静态资源 → dist/
npm run dev                 # Vite 开发服务器（调试 popup 界面用）
npm run typecheck           # 类型检查，不产出文件
```

关于 `--include=dev`：部分环境设置了 `NODE_ENV=production`，此时 `npm install` 会**静默跳过 devDependencies** ——
提示 `up to date` 但 `node_modules` 是空的，必须先带上 `--include=dev` 才能装上构建工具。

`dist/` 是唯一产物目录，也是 `chrome://extensions` 要加载的目录。

---

## 安装与构建

以下是完整的安装步骤与构建命令说明（从 README 移入）。

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
