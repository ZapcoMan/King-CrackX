import { ref, watch, onMounted } from 'vue';

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

function setTheme(theme: ThemeMode): void {
    currentTheme.value = theme;
    saveTheme(theme);
    applyTheme(theme);
}

function getThemeLabel(theme: ThemeMode): string {
    const labels: Record<ThemeMode, string> = {
        light: '浅色',
        dark: '深色',
        system: '跟随系统',
        geek: '极客'
    };
    return labels[theme];
}

watch(currentTheme, theme => {
    applyTheme(theme);
});

onMounted(() => {
    const saved = loadTheme();
    currentTheme.value = saved;
    applyTheme(saved);

    if (saved === 'system') {
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        media.addEventListener('change', () => {
            applyTheme('system');
        });
    }
});

export function useTheme() {
    return {
        currentTheme,
        isDark,
        setTheme,
        getThemeLabel
    };
}