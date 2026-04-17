import { useEffect, useState, useCallback } from 'react';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { useAgentStore } from '../store/useAgentStore';

export type Theme = 'dark' | 'light' | 'system';

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
            const { updateConfig } = useAgentStore.getState();
            updateConfig({
              enabled: loadedSettings.agentEnabled ?? true,
              autoExecute: loadedSettings.agentAutoExecute ?? true,
              maxExecutionSteps: loadedSettings.agentMaxExecutionSteps ?? 20,
              maxContextMessages: loadedSettings.agentMaxContextMessages ?? 20,
              maxTerminalOutputLength: loadedSettings.agentMaxTerminalOutputLength ?? 8000,
              trimContextEnabled: loadedSettings.agentTrimContextEnabled ?? true,
            });
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
        console.log('Settings saved successfully');
      } catch (error) {
        console.error('Failed to save settings:', error);
      }
    }

    // 同步智能体配置
    const { updateConfig } = useAgentStore.getState();
    updateConfig({
      enabled: newSettings.agentEnabled ?? true,
      autoExecute: newSettings.agentAutoExecute ?? true,
      maxExecutionSteps: newSettings.agentMaxExecutionSteps ?? 20,
      maxContextMessages: newSettings.agentMaxContextMessages ?? 20,
      maxTerminalOutputLength: newSettings.agentMaxTerminalOutputLength ?? 8000,
      trimContextEnabled: newSettings.agentTrimContextEnabled ?? true,
    });
  };

  return { theme, changeTheme, settings, updateSettings: setSettings };
}
