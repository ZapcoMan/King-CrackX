/**
 * popup 应用入口。
 *
 * 由 Vite 处理：编译后的产物会自动注入到 popup.html，
 * 不再需要在 HTML 里手写 <script src="popup.js"> —— 这正是要改用 Vite 的原因之一：
 * 产物文件名（含 hash）由构建工具负责写回 HTML，不存在「引用的文件不存在」的问题。
 */

import { createApp } from 'vue';
import App from './App.vue';
import './styles/popup.css';

createApp(App).mount('#app');
