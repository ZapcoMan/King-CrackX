import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = path.join(ROOT, 'dist');

/**
 * 需要打包成「自包含普通脚本」的扩展注入脚本。
 *
 * 为什么它们不能和 popup 走同一个构建：
 *   popup 是普通的页面，可以是 ES Module；
 *   但这 5 个脚本的加载方式决定了它们必须是**自包含的 IIFE 普通脚本**：
 *     - content.js    由 manifest 的 content_scripts 加载（不支持 ESM）
 *     - background.js 由 manifest 的 service_worker 加载（未声明 type: module）
 *     - detector.js / api-extractor.js 通过 <script src> 注入页面 MAIN world
 *     - all-in.js     通过 chrome.scripting.registerContentScripts 注册
 *   所以它们不共享代码、不做 code splitting，每个都单独打包成一个 IIFE。
 */
const EXTENSION_SCRIPTS = ['background', 'content', 'detector', 'all-in', 'api-extractor'] as const;

/**
 * 移除产物开头的 `"use strict";`。
 *
 * 为什么必须移除：
 *   这 5 个脚本在重构前都是**非严格脚本**。加上严格模式会改变运行时语义，
 *   典型差异是「把方法解构出来单独调用时 this 不再兜底为全局对象」——
 *   例如 `const p = arr.push; p(1)` 在非严格模式下写到 window 上、严格模式下直接抛错。
 *   Rollup 的 `generatedCode.strict: false` 关不掉转译层注入的这条指令，
 *   因此这里在输出阶段精确剔除它。
 *
 * 安全性：本项目源码里没有任何手写的 "use strict"，所以只会命中转译注入的那一条。
 */
function stripUseStrictPlugin(): Plugin {
    return {
        name: 'king-crackx:strip-use-strict',
        enforce: 'post',
        renderChunk(code: string) {
            const stripped = code.replace(/\n\s*["']use strict["'];\n/, '\n');
            return stripped === code ? null : { code: stripped, map: null };
        }
    };
}

/**
 * 逐个构建注入脚本。
 *
 * 为什么要 for 循环而不是一次多入口：
 *   Rollup 的 IIFE 输出格式不支持多入口（会因 code splitting 直接报错），
 *   因此每个脚本都必须作为独立构建执行一次。
 */
async function buildExtensionScripts(): Promise<void> {
    const { build } = await import('vite');

    for (const name of EXTENSION_SCRIPTS) {
        await build({
            configFile: false,
            publicDir: false,
            logLevel: 'warn',
            plugins: [stripUseStrictPlugin()],
            build: {
                outDir: DIST,
                // 不能清空：popup 产物与前面几个脚本已经在里面了
                emptyOutDir: false,
                minify: false,
                target: 'chrome110',
                rollupOptions: {
                    /**
                     * 关闭 tree-shaking。
                     * 这些脚本是安全工具的一部分，产物需要能被逐行审计 ——
                     * 保留源码中的全部函数（包括当前未被调用的辅助函数），
                     * 避免出现「源码里有、产物里没有」这种审计时的困惑。
                     */
                    treeshake: false,
                    input: path.join(ROOT, 'src', 'extension', `${name}.ts`),
                    output: {
                        format: 'iife',
                        entryFileNames: `${name}.js`
                    }
                }
            }
        });
    }
}

/** 把注入脚本的构建挂到 popup 构建之后，使 `vite build` 一条命令产出全部产物 */
function extensionScriptsPlugin(): Plugin {
    return {
        name: 'king-crackx:extension-scripts',
        apply: 'build',
        async closeBundle() {
            await buildExtensionScripts();
        }
    };
}

/**
 * King-CrackX 的统一构建配置。
 *
 * 一次 `vite build` 产出全部内容：
 *   - index.html                    ← popup 入口（manifest 的 default_popup 指向它）
 *   - assets/popup.js|popup.css     ← Vue 应用（脚本/样式引用由 Vite 自动注入 HTML）
 *   - background.js / content.js / detector.js / all-in.js / api-extractor.js
 *   - manifest.json / icons/        ← 由 publicDir 原样复制
 *
 * 为什么 minify 关闭：
 *   这是安全工具，使用者需要能直接审阅扩展实际执行的代码。
 */
export default defineConfig({
    plugins: [vue(), extensionScriptsPlugin()],
    /**
     * 相对路径引用资源。
     * 扩展页面通过 chrome-extension://<id>/index.html 加载，
     * 相对路径比根绝对路径更稳，也与扩展自身的资源解析规则一致。
     */
    base: './',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'chrome110',
        minify: false,
        rollupOptions: {
            output: {
                entryFileNames: 'assets/[name].js',
                chunkFileNames: 'assets/[name].js',
                assetFileNames: 'assets/[name][extname]'
            }
        }
    }
});
