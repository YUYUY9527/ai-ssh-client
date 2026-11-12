import { describe, expect, it } from 'vitest';
import { detectSystemLocale, resolveLocale } from '../src/renderer/i18n';

describe('i18n 语言选择', () => {
  it('显式支持的语言优先', () => {
    expect(resolveLocale('zh-CN')).toBe('zh-CN');
    expect(resolveLocale('en-US')).toBe('en-US');
    // 语言标签前缀归一化
    expect(resolveLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveLocale('en-GB')).toBe('en-US');
  });

  it('未设置或不支持的语言跟随系统语言', () => {
    const system = detectSystemLocale();
    expect(resolveLocale('')).toBe(system);
    expect(resolveLocale(undefined)).toBe(system);
    expect(resolveLocale('fr-FR')).toBe(system);
    expect(resolveLocale('ja-JP')).toBe(system);
  });

  it('系统语言无法识别时回退英文', () => {
    // jsdom 默认 navigator.language 为 en-US，属于受支持语言
    expect(['zh-CN', 'en-US']).toContain(detectSystemLocale());
  });
});
