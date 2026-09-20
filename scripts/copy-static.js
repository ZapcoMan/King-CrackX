/**
 * 构建后处理：把扩展运行所需的静态资源复制到 dist/。
 *
 * 为什么需要：
 *   tsc 只负责把 src/*.ts 编译成 dist/*.js，但一个可加载的 Chrome 扩展还需要
 *   manifest.json（清单）、popup.html（弹窗页面）与 icons/（图标）。
 *   这一步让 dist/ 成为「可以直接在 chrome://extensions 里加载」的完整扩展目录，
 *   从而把「源码」与「产物」彻底分离 —— 根目录不再出现任何 .js 文件。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/** 需要平铺复制到 dist 根下的文件 */
const FILES = ['manifest.json', 'popup.html'];
/** 需要整目录复制的资源目录 */
const DIRECTORIES = ['icons'];

fs.mkdirSync(DIST, { recursive: true });

for (const file of FILES) {
    fs.copyFileSync(path.join(ROOT, file), path.join(DIST, file));
    console.log(`[copy] ${file}`);
}

for (const dir of DIRECTORIES) {
    fs.cpSync(path.join(ROOT, dir), path.join(DIST, dir), { recursive: true });
    console.log(`[copy] ${dir}/`);
}

console.log('[build] dist/ 已就绪，可在 chrome://extensions 中加载该目录');
