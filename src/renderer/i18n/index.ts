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

/** 支持的语言列表（其余语言一律回退英文）。 */
const SUPPORTED_LOCALES: Locale[] = ['zh-CN', 'en-US'];

/**
 * 把任意语言标签（如 zh-Hans-CN、en-GB）归一化为受支持的语言。
 * 无法识别时返回 undefined。
 */
function normalizeLocale(tag: string | undefined | null): Locale | undefined {
  if (!tag) return undefined;
  const lower = tag.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en-US';
  return undefined;
}

/**
 * 依据浏览器/系统语言判断默认语言：
 * 依次检查 navigator.languages，命中中文用 zh-CN、命中英文用 en-US，
 * 其他语言（含全部不匹配）回退到 en-US。
 */
export function detectSystemLocale(): Locale {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const candidates =
    nav && Array.isArray(nav.languages) && nav.languages.length > 0
      ? nav.languages
      : nav?.language
        ? [nav.language]
        : [];
  for (const candidate of candidates) {
    const matched = normalizeLocale(candidate);
    if (matched) return matched;
  }
  return 'en-US';
}

/**
 * 计算最终生效语言：用户显式设置的语言优先（必须是受支持的语言），
 * 否则跟随系统语言，非受支持语言回退英文。
 */
export function resolveLocale(preferred?: string): Locale {
  const explicit = normalizeLocale(preferred);
  if (explicit && SUPPORTED_LOCALES.includes(explicit)) return explicit;
  return detectSystemLocale();
}

export const useI18nStore = create<I18nState>((set) => ({
  locale: detectSystemLocale(),
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
    // 回退到英文（默认语言，覆盖面最广）
    const fallback = getNestedValue(locales['en-US'], key);
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
