import zhCN from './zh-CN';
import enUS from './en-US';
import type { Locale } from '../types';

type DeepStringRecord<T> = {
  [K in keyof T]: T[K] extends object ? DeepStringRecord<T[K]> : string;
};

export type Messages = DeepStringRecord<typeof zhCN>;

export const locales: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

export const localeNames: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

export { zhCN, enUS };
