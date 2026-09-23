import { ref, watch } from 'vue';

export type ThemeMode = 'light' | 'dark' | 'system' | 'geek';

const STORAGE_KEY = 'king-crackx-theme';

const currentTheme = ref<ThemeMode>('geek');

const isDark = ref(true);

function applyTheme(theme: ThemeMode): void {
    let dark = true;

    if (theme === 'system') {
        dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else if (theme === 'light') {
        dark = false;
    } else if (theme === 'dark') {
        dark = true;
    } else if (theme === 'geek') {
        dark = true;
    }

    isDark.value = dark;

    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-color-scheme', dark ? 'dark' : 'light');
}

function saveTheme(theme: ThemeMode): void {
    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // ignore
    }
}

function loadTheme(): ThemeMode {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved && ['light', 'dark', 'system', 'geek'].includes(saved)) {
            return saved as ThemeMode;
        }
    } catch {
        // ignore
    }
    return 'geek';
}

/**
 * 切换主题。
 *
 * 执行顺序：
 *   1. 更新响应式状态（触发 UI 重新渲染）
 *   2. 持久化到 localStorage（下次打开自动恢复）
 *   3. 应用主题到 DOM（设置 data-theme / data-color-scheme 属性）
 *
 * @param theme - 目标主题模式
 */
function setTheme(theme: ThemeMode): void {
    currentTheme.value = theme;
    saveTheme(theme);
    applyTheme(theme);
}

/**
 * 获取主题的中文显示标签。
 *
 * @param theme - 主题模式
 * @returns 对应的中文名称，用于设置面板下拉选项显示
 */
function getThemeLabel(theme: ThemeMode): string {
    const labels: Record<ThemeMode, string> = {
        light: '浅色',
        dark: '深色',
        system: '跟随系统',
        geek: '极客'
    };
    return labels[theme];
}

const savedTheme = loadTheme();
currentTheme.value = savedTheme;
applyTheme(savedTheme);

if (savedTheme === 'system') {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        applyTheme('system');
    });
}

watch(currentTheme, theme => {
    applyTheme(theme);
});

export function useTheme() {
    return {
        currentTheme,
        isDark,
        setTheme,
        getThemeLabel
    };
}