import { describe, it, expect } from 'vitest';
import {
  ALT_ENTER_SEQUENCE,
  prepareWindowForReplay,
} from '../src/renderer/session/terminal/terminal-alt';

/** 模拟连续截断：每次 append 后窗口 = prepareWindowForReplay(prev + delta, limit)。 */
function simulateRepeatedTruncation(stream: string, maxBytes: number, chunkSize: number): string[] {
  let windowed = '';
  const history: string[] = [];
  for (let i = 0; i < stream.length; i += chunkSize) {
    windowed = prepareWindowForReplay(windowed + stream.slice(i, i + chunkSize), maxBytes);
    history.push(windowed);
  }
  return history;
}

describe('模拟连续截断（防注入死循环/丢状态）', () => {
  it('长 nano 流连续截断：窗口始终进入 alt，且不会无限注入堆积', () => {
    // 构造 nano 风格流
    const body: string[] = [];
    let s = ALT_ENTER_SEQUENCE + '\x1b[1;32r\x1b[H\x1b[2J';
    let line = 1;
    while (s.length < 1000000) {
      s += `\r\x1b[2dLine number ${line} - some content to make it non-trivial`;
      line += 1;
    }
    const maxBytes = 65536;
    const history = simulateRepeatedTruncation(s, maxBytes, 8192);

    let last = history[history.length - 1];
    expect(last.startsWith(ALT_ENTER_SEQUENCE)).toBe(true);
    // 每个窗口都应该以注入头开始（保持 alt 状态可恢复）
    for (const h of history.slice(-20)) {
      expect(h.startsWith(ALT_ENTER_SEQUENCE)).toBe(true);
    }
    // 无堆积：每次窗口长度有界
    expect(last.length).toBeLessThanOrEqual(maxBytes + ALT_ENTER_SEQUENCE.length);
  });

  it('窗口被滑掉注入头后再次截断：fullContent 仍能识别 alt 状态', () => {
    // 场景：窗口含注入头 → 下次 append 大量内容 → 注入头被滑掉
    // fullContent = (注入头+旧窗口) + delta → scanAltScreenState 应为 true
    const base = ALT_ENTER_SEQUENCE + '\x1b[2J'.repeat(3);
    const filler = '\r\x1b[2dLine xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.repeat(10000);
    const stream = base + filler + '\x1b[2dLine at very end';
    // 第一次截断：注入头在窗口内 → 保持
    const w1 = prepareWindowForReplay(stream, 65536);
    expect(w1.startsWith(ALT_ENTER_SEQUENCE)).toBe(true);

    // 第二次截断：窗口 = w1 + 新内容，注入头还在窗口内（未滑掉）→ 不注入
    const w2 = prepareWindowForReplay(w1 + filler, 65536);
    expect(w2.length).toBeLessThanOrEqual(65536 + ALT_ENTER_SEQUENCE.length);
    // 窗口仍以注入头开始（w1 的头部还在 65536 内）
    expect(w2.startsWith(ALT_ENTER_SEQUENCE)).toBe(true);
  });
});
