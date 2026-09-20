/**
 * popup 应用的模块声明补充。
 *
 * 为什么需要：
 *   TypeScript 本身不认识 `.vue` 单文件组件，这个声明让
 *   `import App from './App.vue'` 在 IDE 与类型检查中成立。
 *   （实际的 SFC 解析由 Vite + @vitejs/plugin-vue 完成，编译期不需要它。）
 */

declare module '*.vue' {
    import type { DefineComponent } from 'vue';

    const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
    export default component;
}
