import { useEffect, useState, useCallback } from 'react';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { useAgentStore } from '../store/useAgentStore';
import { useI18nStore, resolveLocale } from '../i18n';
import type { Locale } from '../i18n';
import { ensureWebFontLoaded } from './web-fonts';

export type Theme = 'dark' | 'light' | 'system';

const CJK_UI_FALLBACKS = ["'PingFang SC'", "'Microsoft YaHei'", "'Segoe UI'", 'system-ui'];
const GENERIC_FONT_FAMILIES = new Set([
  'monospace',
  'sans-serif',
  'serif',
  'system-ui',
  'ui-monospace',
  'ui-sans-serif',
]);

/**
 * 将终端字体设置转换为全局安全字体栈：
 * 把中文字体回退插在 `monospace` / `sans-serif` 通用族之前，
 * 既让英文/数字/命令使用用户所选字体，又避免 Windows 下中文落回宋体（SimSun）。
 */
export function buildGlobalFontStack(fontFamily?: string): string {
  const parts = String(fontFamily || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const specific = parts.filter((part) => !GENERIC_FONT_FAMILIES.has(part.toLowerCase()));
  const generic = parts.filter((part) => GENERIC_FONT_FAMILIES.has(part.toLowerCase()));
  const tail = generic.length > 0 ? generic : ['sans-serif'];
  return [...specific, ...CJK_UI_FALLBACKS, ...tail].join(', ');
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>('dark');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  // 加载设置
  useEffect(() => {
    const loadSettings = async () => {
      if (window.electronAPI) {
        try {
          const result = await window.electronAPI.getSettings();
          if (result.success) {
            const loadedSettings = result.data?.settings ?? DEFAULT_SETTINGS;
            setSettings(loadedSettings);
            setTheme(loadedSettings.theme);
            applyTheme(loadedSettings.theme);

            // 同步智能体配置
            useAgentStore.getState().syncFromSettings(loadedSettings);
            // 同步语言：显式设置优先，未设置时按系统语言自动选择（不支持则英文）
            useI18nStore.getState().setLocale(resolveLocale(loadedSettings.language) as Locale);
          }
        } catch (error) {
          console.error('Failed to load settings:', error);
        }
      }
    };
    loadSettings();
  }, []);

  // 应用主题到 document
  const applyTheme = useCallback((newTheme: Theme) => {
    const root = document.documentElement;

    // 移除旧的主题类
    root.classList.remove('dark', 'light');

    if (newTheme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.add(prefersDark ? 'dark' : 'light');
    } else {
      root.classList.add(newTheme);
    }

    console.log('Theme applied:', newTheme, 'Classes:', document.documentElement.className);
  }, []);

  // 当主题状态改变时应用主题
  useEffect(() => {
    applyTheme(theme);
  }, [theme, applyTheme]);

  // 将终端设置里的字体样式同步应用到全局界面（含所有弹窗、输入框与等宽文本）
  useEffect(() => {
    const rawFamily = settings.fontFamily || DEFAULT_SETTINGS.fontFamily;
    const stack = buildGlobalFontStack(rawFamily);
    const root = document.documentElement;
    root.style.setProperty('--app-font-family', stack);
    root.style.setProperty('--app-font-mono', stack);
    void ensureWebFontLoaded(rawFamily);
  }, [settings.fontFamily]);

  // 监听系统主题变化
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      applyTheme('system');
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme, applyTheme]);

  const changeTheme = async (newTheme: Theme) => {
    console.log('Changing theme to:', newTheme);
    setTheme(newTheme);

    const newSettings = { ...settings, theme: newTheme };
    setSettings(newSettings);

    if (window.electronAPI) {
      try {
        await window.electronAPI.saveSettings(newSettings);
      } catch (error) {
        console.error('Failed to save settings:', error);
      }
    }
  };

  return { theme, changeTheme, settings, updateSettings: setSettings };
}
