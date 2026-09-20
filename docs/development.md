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
