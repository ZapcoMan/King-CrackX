# 整体架构：三世界模型

> 本文档是 [README](../README.md) 的补充材料，说明这个扩展的运行环境与消息链路。
> 理解它是读懂后面所有实现的前提。

理解后面所有实现的前提，是这个扩展同时运行在**三个互不相同的 JavaScript 世界**里：

| 世界 | 文件 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| **扩展后台** | `src/extension/background.ts` | 完整的 `chrome.*` API、动态注册内容脚本 | 接触不到页面 DOM |
| **内容脚本**（ISOLATED world） | `src/extension/content.ts` | `chrome.*` API + 页面 DOM | **看不到页面里的 Vue 对象** |
| **页面主世界**（MAIN world） | `detector.ts` / `all-in.ts` / `api-extractor.ts` | 直接读写页面 `window` 与 Vue 内部对象 | **完全不能用 `chrome.*`** |

这决定了两段式的消息链路：

```
Vue popup ──chrome.runtime.sendMessage──▶ content.ts
                                             │ 注入 <script src=chrome.runtime.getURL(...)>
                                             ▼
                    detector.ts / all-in.ts / api-extractor.ts   (MAIN world)
                                             │ window.postMessage
                                             ▼
                        content.ts ──chrome.runtime.sendMessage──▶ Vue popup
```

`content.ts` 存在的唯一理由，就是当这两者之间的传话筒：它能往 MAIN world 注入脚本，能通过 `window.postMessage` 接收主世界的结果，还能调用 `chrome.*` 把结果转给 popup。

**为什么 MAIN world 的脚本不使用 Vue**：它们通过 `<script src>` 或 `chrome.scripting.registerContentScripts` 加载，这两种加载方式**都不支持 ES Module**，所以这些文件不能写 `import` / `export`，也就无法引入任何框架。它们保持「自包含 IIFE 普通脚本」形态 —— 只负责逻辑，不负责界面。

---
