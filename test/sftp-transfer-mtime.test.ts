import { describe, expect, it } from 'vitest';
import { normalizeSourceMtimeSeconds } from '../server/sftp-transfer.cjs';

describe('normalizeSourceMtimeSeconds', () => {
  it('毫秒时间戳换算成秒（File.lastModified 口径）', () => {
    // 2026-11-12T00:00:00Z 的毫秒时间戳
    expect(normalizeSourceMtimeSeconds(1762896000000)).toBe(1762896000);
    expect(normalizeSourceMtimeSeconds('1762896000123')).toBe(1762896000);
  });

  it('秒级时间戳原样保留', () => {
    expect(normalizeSourceMtimeSeconds(1762896000)).toBe(1762896000);
    expect(normalizeSourceMtimeSeconds('1762896000')).toBe(1762896000);
  });

  it('缺失或非法值按 0 处理', () => {
    expect(normalizeSourceMtimeSeconds(undefined)).toBe(0);
    expect(normalizeSourceMtimeSeconds('')).toBe(0);
    expect(normalizeSourceMtimeSeconds('abc')).toBe(0);
  });
});
