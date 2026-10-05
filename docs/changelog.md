# King-CrackX 更新日志

## v0.3.0 - React 框架支持

### 新增功能

#### React 自动检测与路由分析
- `detector.ts` 升级为**框架自动分发**：先探测 Vue，未命中再探测 React，二者共用同一套消息协议（结果对象新增 `framework` 字段）。
- React 检测覆盖三种挂载标记：`__reactContainer$`（18+ 并发根）、`_reactRootContainer`（≤17 legacy）、`__reactFiber$`（兜底上溯根）。
- 版本识别按可信度回退：`window.React.version` → DevTools 钩子 renderers → 基于挂载标记的启发式大版本标签。
- 路由枚举：从 Fiber 树发现 v6.4+ data router 实例（`routes` + `navigate` + `state` 三要素判定），递归展开相对路径为完整路径；拿不到可静态枚举的实例时退化为运行时 `state.matches` 收集，并复用页面链接前缀分析推测候选基础路径。

#### React 梭哈模式（绕过鉴权跳转）
- `all-in.ts` 的 `scanRouters` 同时接管 Vue Router 与 React Router（同一元素先 Vue 后 React）。
- React Router v6 无集中式守卫，鉴权统一经 `router.navigate`，故接管聚焦「跳转层」：替换 `navigate` 为拦截器阻止被踢回登录页；浏览器层（`history.*` / `location.*` / `window.close`）拦截与框架无关，React 同样受益。

### UI 适配
- `RouterPanel.vue` / `useRouterAnalysis.ts` 变为框架感知：版本标题、状态文案按命中的框架显示（如「当前React版本」）；`no-vue` 文案改为「未检测到 Vue/React 应用」，`no-router` 提示「检测到 X，但未找到可枚举的路由」。

### 已知限制
- 声明式 `<Routes>/<Route>`（非 data router）在运行时没有可静态枚举的集中路由表，此类页面可能仅能拿到当前匹配路径；推荐用 data router 的站点可获得完整路由清单。

### 说明
- React 检测/枚举逻辑折入现有 `detector.ts` 与 `all-in.ts`，**未新增注入脚本文件**，因此 `vite.config.ts`、`manifest.json` 的打包与 `web_accessible_resources` 配置无需改动。

## v0.2.0 - 主题系统与极客风格 UI

### 新增功能

#### 多主题切换
- 标题栏右侧添加齿轮图标设置按钮
- 设置面板包含主题下拉选择器，支持四种模式：
  - **浅色** — 明亮简洁的白底风格
  - **深色** — 柔和的深蓝暗色风格
  - **跟随系统** — 自动匹配操作系统的亮/暗模式
  - **极客** — 赛博朋克霓虹风格（默认主题）
- 主题选择后即时生效，保存到 localStorage，下次打开自动恢复

#### 极客风格 UI 设计
- 深色背景搭配霓虹绿/霓虹蓝光效
- CRT 扫描线效果（仅极客主题）
- 等宽字体（JetBrains Mono / Fira Code）
- 所有交互元素带霓虹发光效果
- 标题、按钮、徽章等组件均有发光阴影

### 技术实现

#### 新增文件
- `src/composables/useTheme.ts` — 主题管理组合式函数
  - 主题状态管理（模块级单例）
  - 主题应用逻辑（通过 `data-theme` 和 `data-color-scheme` 属性）
  - localStorage 持久化存储
  - 系统主题变化监听

- `src/components/SettingsPanel.vue` — 设置面板组件
  - 齿轮图标 + 主题下拉选择器
  - 毛玻璃遮罩背景，点击遮罩关闭

#### 修改文件
- `src/App.vue` — 添加设置按钮和设置面板显示控制
- `src/styles/popup.css` — 新增主题相关 CSS 变量和样式
  - `:root` — 全局霓虹色变量
  - `[data-theme="light"]` — 浅色主题变量
  - `[data-theme="dark"]` — 深色主题变量
  - `[data-theme="geek"]` — 极客主题变量及专属样式

### 主题差异对比

| 特性 | 浅色 | 深色 | 极客 |
|------|------|------|------|
| 背景色 | 白/浅灰 | 深蓝灰 | 纯黑 |
| 文字色 | 深灰 | 浅灰 | 霓虹绿 |
| 边框 | 浅灰 | 深灰 | 霓虹绿发光 |
| CRT 扫描线 | 无 | 无 | 有 |
| 霓虹光效 | 无 | 无 | 全面覆盖 |