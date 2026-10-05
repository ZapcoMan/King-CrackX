# King-CrackX 更新日志

## v0.3.0 - React 生态框架支持

### 新增功能

#### React 自动检测与框架分发
- `detector.ts` 升级为**框架自动分发**：先探测 Vue，未命中再探测 React，二者共用同一套消息协议（结果对象新增 `framework` 字段）。
- React 检测覆盖三种挂载标记：`__reactContainer$`（18+ 并发根）、`_reactRootContainer`（≤17 legacy）、`__reactFiber$`（兜底上溯根）。
- 版本识别按可信度回退：`window.React.version` → DevTools 钩子 renderers → 基于挂载标记的启发式大版本标签。

#### React 侧多路由库适配（按优先级依次尝试）
不再局限于 React Router data router，`collectReactRoutes` 对**所有与本插件功能（路由枚举 / 绕过）相关的常见 React 路由方案**做了适配，并记录命中的 `routerLib` 与 `routerVersion`：
1. **Next.js** —— `window.next` 存在即判定，Pages Router 枚举 `router.components` 的 keys，App Router 尽力探测 `appRouteCache`。
2. **React Router data router（v6.4+ / v7）** —— 从 Fiber 树发现 `{ routes, navigate, state }` 实例，递归展开相对路径为完整路径；配置树为空时退化到运行时 `state.matches`。
3. **TanStack Router** —— 识别 `{ navigate, state.location, options }` 特征，优先取 `state.routes`，回退 `routesById` / `options.routes`，读取 `fullPath`。
4. **React Router 声明式（v4/v5/v6/v7）** —— 无集中路由表时，遍历 Fiber 从 `memoizedProps.path` 采集 `<Route>` / `<Switch>` 声明的路径，并按形态标注模式标签。
5. **锚点兜底** —— 自研路由或无法静态枚举时，采集站内 `<a href>` 作为候选，标记 `detected: false`。

所有分支均会纳入 `window.location.pathname`，并复用页面链接前缀分析推测候选基础路径，保证列表可用、绕路有落点。

#### React 梭哈模式（绕过鉴权跳转）
- `all-in.ts` 的 `scanRouters` 同时接管 Vue Router 与 React 侧路由实例（同一元素先 Vue 后 React）。
- `isReactRouterLike` 泛化为「可接管的 React 路由实例」判定，同时兼容 React Router 与 TanStack Router；替换其 `navigate` 为拦截器阻止被踢回登录页（返回 `Promise` 以兼容 `.then` 链式调用）。
- 新增 `patchNextRouter`，接管 `window.next.router` 的 `push` / `replace`。
- 浏览器层（`history.*` / `location.*` / `window.close`）拦截与框架无关，React 同样受益。

### UI 适配
- `RouterPanel.vue` / `useRouterAnalysis.ts` 变为框架感知：版本标题、状态文案按命中的框架显示（如「当前React版本」）；`no-vue` 文案改为「未检测到 Vue/React 应用」，`no-router` 提示「检测到 X，但未找到可枚举的路由」。
- ready 状态新增「路由库」行，展示命中的 `routerLib`（Vue 侧固定为 Vue Router）与其版本 / 模式标签。

### 已知限制
- 声明式 React Router（`<Routes>/<Route>`、v5 `<Switch>`）无集中路由表，只能从 Fiber 采集已挂载的 `path`，未渲染的嵌套分支可能采不全、深层相对路径难以还原完整前缀；data router 与 Next.js/TanStack 站点可获得更完整清单。
- Next.js App Router 的路由表在运行时多为编译期产物，`appRouteCache` 探测为尽力而为，命中率低于 Pages Router。

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