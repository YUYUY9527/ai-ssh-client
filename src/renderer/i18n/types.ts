export type Locale = 'zh-CN' | 'en-US';

export type TranslationKeys = typeof import('./locales/zh-CN').default;

export type NestedKeyOf<T, Prefix extends string = ''> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object
        ? NestedKeyOf<T[K], `${Prefix}${K}.`>
        : `${Prefix}${K}`;
    }[keyof T & string]
  : never;

export type TranslationKey = NestedKeyOf<TranslationKeys>;
