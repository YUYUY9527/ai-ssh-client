import { create } from 'zustand';
import { locales, localeNames } from './locales';
import type { Locale } from './types';

export type { Locale };
export { localeNames };

// ============================================================
// i18n Store
// ============================================================

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: 'zh-CN',
  setLocale: (locale) => set({ locale }),
}));

// ============================================================
// Translation helper
// ============================================================

type Translations = typeof import('./locales/zh-CN').default;

/**
 * 根据点分路径从嵌套对象中取值。
 * 例如 getNestedValue(obj, 'agent.states.idle') → obj.agent.states.idle
 */
function getNestedValue(obj: any, path: string): string | undefined {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * 简单的模板插值:把 `{key}` 替换为 params 里对应的值。
 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const value = params[key];
    return value != null ? String(value) : `{${key}}`;
  });
}

/**
 * 翻译函数。
 * 用法:t('agent.states.idle') → '待机'
 *       t('agent.task.rounds', { count: 3 }) → '3 轮'
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const { locale } = useI18nStore.getState();
  const messages = locales[locale];
  const value = getNestedValue(messages, key);
  if (value == null) {
    // 回退到中文
    const fallback = getNestedValue(locales['zh-CN'], key);
    if (fallback != null) return interpolate(fallback, params);
    // 开发时打印 warning
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[i18n] Missing key: ${key}`);
    }
    return key;
  }
  return interpolate(value, params);
}

/**
 * React Hook:返回 t 函数,并在语言切换时触发重渲染。
 */
export function useI18n() {
  const locale = useI18nStore((state) => state.locale);
  // 返回一个闭包,每次 locale 变化时组件会重渲染,t 函数内部读最新 locale
  return { t, locale };
}
