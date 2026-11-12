import { describe, it, expect } from 'vitest';
import { isXtermAutoReply } from '../src/renderer/session/terminal/useTerminalInputTracking';

/**
 * 回归：早期实现"凡是 ESC 开头就当成 xterm 自动应答丢弃"，
 * 会在回放挂起窗口（最长 1.5s）里把用户的方向键/Home/End/F 键/Alt 键一起吞掉，
 * 导致 vim/nano 里方向键短暂失灵。这里锁定"只丢真正的应答报文"。
 */
describe('isXtermAutoReply — 只拦截自动应答，不误伤真实按键', () => {
  it('识别 DA/DSR 等 CSI 应答', () => {
    expect(isXtermAutoReply('\x1b[?1;2c')).toBe(true); // DA1
    expect(isXtermAutoReply('\x1b[>0;95;0c')).toBe(true); // DA2
    expect(isXtermAutoReply('\x1b[12;40R')).toBe(true); // DSR 光标位置
    expect(isXtermAutoReply('\x1b[?2026$y')).toBe(true); // DECRPM
  });

  it('识别焦点与 OSC 应答', () => {
    expect(isXtermAutoReply('\x1b[I')).toBe(true);
    expect(isXtermAutoReply('\x1b[O')).toBe(true);
    expect(isXtermAutoReply('\x1b]11;rgb:0000/0000/0000\x07')).toBe(true);
  });

  it('不得误判用户真实按键（方向键 / Home / End / F 键 / Alt+字母）', () => {
    expect(isXtermAutoReply('\x1b[A')).toBe(false); // ↑
    expect(isXtermAutoReply('\x1b[B')).toBe(false); // ↓
    expect(isXtermAutoReply('\x1b[C')).toBe(false); // →
    expect(isXtermAutoReply('\x1b[D')).toBe(false); // ←
    expect(isXtermAutoReply('\x1b[H')).toBe(false); // Home
    expect(isXtermAutoReply('\x1b[F')).toBe(false); // End
    expect(isXtermAutoReply('\x1bOP')).toBe(false); // F1
    expect(isXtermAutoReply('\x1b[15~')).toBe(false); // F5
    expect(isXtermAutoReply('\x1bb')).toBe(false); // Alt+b
  });

  it('普通字符、回车、退格都不算应答', () => {
    expect(isXtermAutoReply('a')).toBe(false);
    expect(isXtermAutoReply('\r')).toBe(false);
    expect(isXtermAutoReply('\x7f')).toBe(false);
    expect(isXtermAutoReply('')).toBe(false);
  });
});
