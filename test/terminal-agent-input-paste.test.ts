/**
 * @vitest-environment jsdom
 *
 * 终端输入行追踪的 hook 级测试。
 *
 * 两个真实回归：
 * 1. 粘贴「Portainer Agent」后再手打「是什么」并回车，`@ai` 只收到「是什么」——
 *    粘贴被浏览器 paste 事件拦截后直接 `sshExecuteSync` 到远端，不经过 xterm onData。
 * 2. 长输入折行后回车内容被截断 —— `getLine(cursorY)` 只返回一个视觉行，
 *    提示符解析只看得到折行的第一段（落库的 userInput 少了尾巴）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { useTerminalInputTracking } from '../src/renderer/session/terminal/useTerminalInputTracking';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTION_ID = 'conn-1';
const PROMPT = '[root@k8s-slave1 ~]# ';

/** 探针暴露的 hook API。 */
let api: ReturnType<typeof useTerminalInputTracking> | null = null;
let onDataHandler: ((data: string) => void) | null = null;
/** 屏幕上的视觉行（xterm buffer 的行序从下往上，这里按从上到下模拟）。 */
let rows: Array<{ text: string; isWrapped: boolean }> = [];

const sshExecuteSync = vi.fn();
const onAgentInput = vi.fn();
const onExitAgentFollowUp = vi.fn();
/** 当前回复模式：null = 普通 shell，'follow-up' = 连续对话。 */
let replyMode: 'answer' | 'approval' | 'follow-up' | 'busy' | null = 'follow-up';

const fakeTerminal = {
  onData: (handler: (data: string) => void) => {
    onDataHandler = handler;
    return { dispose: () => { onDataHandler = null; } };
  },
  buffer: {
    active: {
      get cursorY() { return Math.max(0, rows.length - 1); },
      getLine: (index: number) => {
        const row = rows[index];
        return row
          ? { isWrapped: row.isWrapped, translateToString: () => row.text }
          : undefined;
      },
    },
  },
  options: {},
};

function Probe() {
  const xtermRef = createRef<never>();
  (xtermRef as { current: unknown }).current = fakeTerminal;
  api = useTerminalInputTracking({
    liveConnectionId: CONNECTION_ID,
    onAgentInput,
    getAgentReplyMode: () => replyMode,
    shouldForceAgentPrefix: () => false,
    onExitAgentFollowUp,
    syncAlternateScreenState: () => false,
    terminalInstanceVersion: 0,
    xtermRef,
  });
  return null;
}

/** 远端当前已回显的输入内容（本站输入的“屏幕事实”）。 */
let screenInput = '';

/** 屏幕只有一个视觉行：提示符 + 已回显内容。 */
function setEchoedInput(text: string) {
  screenInput = text;
  rows = [{ text: `${PROMPT}${text}`, isWrapped: false }];
}

/** 模拟长输入折行：第一段跟在提示符后，剩下的软折行到下一行。 */
function setWrappedInput(head: string, tail: string) {
  screenInput = `${head}${tail}`;
  rows = [
    { text: `${PROMPT}${head}`, isWrapped: false },
    { text: tail, isWrapped: true },
  ];
}

/** 模拟键盘逐字输入（xterm onData），默认远端会同步回显。 */
function type(text: string, options: { echo?: boolean } = {}) {
  act(() => {
    for (const char of text) {
      onDataHandler?.(char);
      if (options.echo !== false) {
        setEchoedInput(`${screenInput}${char}`);
      }
    }
  });
}

/** 模拟按回车。 */
function pressEnter() {
  act(() => {
    onDataHandler?.('\r');
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api = null;
  onDataHandler = null;
  screenInput = '';
  rows = [{ text: PROMPT, isWrapped: false }];
  replyMode = 'follow-up';
  sshExecuteSync.mockClear();
  onAgentInput.mockClear();
  onExitAgentFollowUp.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    sshExecuteSync,
    getCommandHistory: async () => ({ success: true, data: { history: [] } }),
    addCommandHistory: async () => ({ success: true }),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(createElement(Probe)); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('终端输入行追踪 — 粘贴内容不得丢失', () => {
  it('粘贴 + 手打 + 回车：Agent 收到完整的一行', () => {
    act(() => { api?.recordPastedInput('Portainer Agent'); });
    setEchoedInput('Portainer Agent');

    type('是什么');

    expect(onAgentInput).not.toHaveBeenCalled();
    pressEnter();

    expect(onAgentInput).toHaveBeenCalledTimes(1);
    expect(onAgentInput).toHaveBeenCalledWith('Portainer Agent是什么');
    // 提交给 Agent 前清掉远端 shell 上的那一行
    expect(sshExecuteSync).toHaveBeenCalledWith(CONNECTION_ID, '\x15');
  });

  it('纯粘贴后回车同样提交完整内容', () => {
    act(() => { api?.recordPastedInput('docker ps'); });
    setEchoedInput('docker ps');

    pressEnter();

    expect(onAgentInput).toHaveBeenCalledWith('docker ps');
  });

  it('多行粘贴会被远端逐行执行：后续回车不把粘贴内容塞进本次提问', () => {
    act(() => { api?.recordPastedInput('echo a\necho b'); });
    setEchoedInput('');

    type('检查磁盘');

    pressEnter();

    expect(onAgentInput).toHaveBeenCalledTimes(1);
    expect(onAgentInput).toHaveBeenCalledWith('检查磁盘');
  });

  it('普通 shell 模式（非连续对话）下粘贴内容按 shell 命令处理', () => {
    replyMode = null;
    act(() => { api?.recordPastedInput('free -h'); });
    setEchoedInput('free -h');

    pressEnter();

    expect(onAgentInput).not.toHaveBeenCalled();
    expect(sshExecuteSync).toHaveBeenCalledWith(CONNECTION_ID, '\r');
  });
});

describe('终端输入行追踪 — 长输入折行不得截断', () => {
  it('折行且本地追踪为空时，按屏幕完整逻辑行提交', () => {
    setWrappedInput('还能查询到其他虚拟', '机吗');

    pressEnter();

    expect(onAgentInput).toHaveBeenCalledWith('还能查询到其他虚拟机吗');
  });

  it('本地追踪只有折行前的一段时，以屏幕完整内容为准', () => {
    // 模拟追踪被截断：只记录到第一段
    type('还能查询到其他虚拟');
    setWrappedInput('还能查询到其他虚拟', '机吗');

    pressEnter();

    expect(onAgentInput).toHaveBeenCalledWith('还能查询到其他虚拟机吗');
  });

  it('折行的 @ai 行仍被识别为 Agent 输入（prompt 判定用逻辑行）', () => {
    replyMode = null;
    setWrappedInput('@ai 帮我看看这台服务器上', '跑了哪些容器');

    pressEnter();

    expect(onAgentInput).toHaveBeenCalledWith('帮我看看这台服务器上跑了哪些容器');
  });

  it('回显滞后时以本地追踪为准（不丢最近键入的字符）', () => {
    type('docker ps -a', { echo: false });
    // 屏幕只回显到一半
    setEchoedInput('docker ps');

    pressEnter();

    expect(onAgentInput).toHaveBeenCalledWith('docker ps -a');
  });

  it('本地追踪漂移时以屏幕为准（真实回归：框里出现错位的「其他」）', () => {
    // 追踪里多出错位内容（模拟 Delete / 光标编辑 / 输入法候选后追踪未能还原）
    type('还能查询到其他虚拟其他', { echo: false });
    // 屏幕是远端已回显的事实
    setEchoedInput('还能查询到其他虚拟机吗');

    pressEnter();

    expect(onAgentInput).toHaveBeenCalledWith('还能查询到其他虚拟机吗');
  });

  it('空行回车仍然退出连续对话，不会把上一条命令重新提交', () => {
    // 输出尾部里有上一条命令（旧回退逻辑会把它当成本次输入）
    act(() => { api?.consumeOutputChunk(`${PROMPT}docker ps\r\n`); });
    setEchoedInput('');

    pressEnter();

    expect(onAgentInput).not.toHaveBeenCalled();
    expect(onExitAgentFollowUp).toHaveBeenCalledTimes(1);
  });
});
