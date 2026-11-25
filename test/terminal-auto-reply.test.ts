// @vitest-environment jsdom
import React, { useEffect } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isXtermAutoReply,
  useTerminalInputTracking,
} from '../src/renderer/session/terminal/useTerminalInputTracking';
import { stripReplayTerminalQueries } from '../src/renderer/session/terminal/terminal-replay';

/**
 * 回归：早期实现"凡是 ESC 开头就当成 xterm 自动应答丢弃"，
 * 会在回放挂起窗口（最长 1.5s）里把用户的方向键/Home/End/F 键/Alt 键一起吞掉，
 * 导致 vim/nano 里方向键短暂失灵。这里锁定"只丢真正的应答报文"。
 */
describe('isXtermAutoReply — 只拦截自动应答，不误伤真实按键', () => {
  it('识别 DA/DSR/DECRPM/XTWINOPS 等 CSI 应答', () => {
    expect(isXtermAutoReply('\x1b[?1;2c')).toBe(true); // DA1
    expect(isXtermAutoReply('\x1b[>0;95;0c')).toBe(true); // DA2
    expect(isXtermAutoReply('\x1b[12;40R')).toBe(true); // DSR 光标位置
    expect(isXtermAutoReply('\x1b[?2026$y')).toBe(true); // DEC private DECRPM
    expect(isXtermAutoReply('\x1b[4;2$y')).toBe(true); // ANSI DECRPM
    expect(isXtermAutoReply('\x1b[8;40;120t')).toBe(true); // XTWINOPS 尺寸应答
  });

  it('识别焦点与 OSC 应答（BEL 与 ST 结尾）', () => {
    expect(isXtermAutoReply('\x1b[I')).toBe(true);
    expect(isXtermAutoReply('\x1b[O')).toBe(true);
    expect(isXtermAutoReply('\x1b]11;rgb:0000/0000/0000\x07')).toBe(true);
    expect(isXtermAutoReply('\x1b]10;rgb:e2e2/e8e8/f0f0\x1b\\')).toBe(true);
    expect(isXtermAutoReply('\x1b]4;0;rgb:0707/0b0b/1010\x1b\\')).toBe(true);
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

describe('stripReplayTerminalQueries — 剥离历史重放中的终端查询序列', () => {
  it('剥离 OSC 颜色查询（4/10/11/12 等）及 CSI/DCS 设备查询', () => {
    const raw = [
      'prompt$ ',
      '\x1b]10;?\x07',
      '\x1b]11;?\x1b\\',
      '\x1b]10;?;?;?\x07',
      '\x1b]4;0;?;1;?;2;?\x1b\\',
      '\x1b[c',
      '\x1b[0c',
      '\x1b[>c',
      '\x1b[6n',
      '\x1b[?2026$p',
      '\x1b[18t',
      '\x1bP$q"q\x1b\\',
      '\x1bP+q544e\x1b\\',
      'hello',
    ].join('');
    expect(stripReplayTerminalQueries(raw)).toBe('prompt$ hello');
  });

  it('保留正常颜色设置、SGR、alt screen 与 OSC 7/133 序列', () => {
    const raw = [
      '\x1b[?1049h',
      '\x1b[1;32mOK\x1b[0m',
      '\x1b]11;rgb:0000/0000/0000\x07',
      '\x1b]4;0;#070b10\x1b\\',
      '\x1b]7;file://host/tmp/a?b=1\x07',
      '\x1b]133;A\x07',
      '\x1b]0;vim ? title\x07',
    ].join('');
    expect(stripReplayTerminalQueries(raw)).toBe(raw);
  });
});

describe('useTerminalInputTracking — 首次挂载重放挂起不被 terminalInstanceVersion 清零', () => {
  afterEach(() => {
    delete (window as any).electronAPI;
    document.body.innerHTML = '';
  });

  it('Commit 1 挂起后 Commit 2 绑定 onData 时仍拦截 rgb 应答，不误拦真实按键', async () => {
    const sshExecuteSync = vi.fn();
    (window as any).electronAPI = { sshExecuteSync };

    let onDataCb: ((data: string) => void) | null = null;
    const mockTerm = {
      buffer: { active: { type: 'normal', cursorY: 0, getLine: () => null } },
      onData: vi.fn((cb: (data: string) => void) => {
        onDataCb = cb;
        return {
          dispose: () => {
            if (onDataCb === cb) onDataCb = null;
          },
        };
      }),
    };

    const xtermRef: { current: any } = { current: null };
    let api: ReturnType<typeof useTerminalInputTracking> | null = null;

    function Harness({ version }: { version: number }) {
      api = useTerminalInputTracking({
        liveConnectionId: 'conn-a',
        syncAlternateScreenState: () => false,
        terminalInstanceVersion: version,
        xtermRef,
      });
      // 模拟 useXtermInstance 在 Commit 1 同步写入 xtermRef，紧接着 TerminalView 发起 replay 挂起
      useEffect(() => {
        if (version === 0) {
          xtermRef.current = mockTerm;
          api?.beginSuspendInputForward();
        }
      }, [version]);
      return null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    // Commit 1：建实例并开启 replay suspend
    await act(async () => {
      root.render(React.createElement(Harness, { version: 0 }));
    });
    // Commit 2：terminalInstanceVersion 0 -> 1，绑定 onData
    await act(async () => {
      root.render(React.createElement(Harness, { version: 1 }));
    });

    expect(onDataCb).toBeTypeOf('function');

    // xterm 异步解析重放缓冲触发 OSC rgb 应答：必须被拦截
    onDataCb!('\x1b]10;rgb:e2e2/e8e8/f0f0\x1b\\');
    onDataCb!('\x1b]11;rgb:0707/0b0b/1010\x1b\\');
    expect(sshExecuteSync).not.toHaveBeenCalled();

    // 重放挂起期间用户敲普通字符：照常转发
    onDataCb!('a');
    expect(sshExecuteSync).toHaveBeenCalledTimes(1);
    expect(sshExecuteSync).toHaveBeenLastCalledWith('conn-a', 'a');

    // 重放 write 回调释放挂起后，实时 OSC 应答恢复正常转发
    api!.endSuspendInputForward();
    onDataCb!('\x1b]11;rgb:0707/0b0b/1010\x1b\\');
    expect(sshExecuteSync).toHaveBeenCalledTimes(2);
    expect(sshExecuteSync).toHaveBeenLastCalledWith('conn-a', '\x1b]11;rgb:0707/0b0b/1010\x1b\\');

    await act(async () => {
      root.unmount();
    });
  });
});
