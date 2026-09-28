/**
 * @vitest-environment jsdom
 *
 * 终端 Agent 输出投影（`useTerminalAgentOutput`）的状态机测试。
 *
 * 背景（真实回归）：任务结束的结束摘要打印之后，终端最下方会多出一行
 * 「Agent · 思考中」，并且第二次结束时不会再打印摘要 —— 用户看到的就是
 * 「AI 回复完了，下面还挂着个思考中」。运行时侧已修复（见 agent-runtime 的
 * `disposed` 守卫），这里锁定投影层契约：**结束摘要必须能重新打印，终端不得
 * 以一行状态标签收尾**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { useTerminalAgentOutput } from '../src/renderer/session/terminal/useTerminalAgentOutput';
import { useAgentStore } from '../src/renderer/store/useAgentStore';
import { useSessionStore } from '../src/renderer/session/useSessionStore';
import { t } from '../src/renderer/i18n';
import type { AgentTask } from '../src/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = 'conn-1';

const writes: string[] = [];
const fakeTerminal = {
  write: (chunk: string) => { writes.push(chunk); },
};

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    connectionId: SESSION_ID,
    userInput: '你好',
    state: 'thinking',
    thinkingSteps: [],
    executions: [],
    startTime: Date.now(),
    ...overrides,
  };
}

function Probe() {
  const xtermRef = createRef<never>();
  (xtermRef as { current: unknown }).current = fakeTerminal;
  useTerminalAgentOutput({
    isAlternateScreen: false,
    sessionId: SESSION_ID,
    terminalInstanceVersion: 0,
    translate: t,
    xtermRef,
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  writes.length = 0;
  useSessionStore.setState({ activeSessionId: SESSION_ID } as never);
  useAgentStore.setState({ currentTask: null, agentState: 'idle' } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(createElement(Probe)); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

/** 终端纯文本（去掉 ANSI 转义）。 */
function plainText(): string {
  return writes
    .join('')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r\n/g, '\n');
}

/** 非空行，末行即用户看到的最后一行。 */
function lines(): string[] {
  return plainText().split('\n').filter((line) => line.trim().length > 0);
}

function finishTask(finishReason: string) {
  act(() => {
    useAgentStore.setState({
      agentState: 'finished',
      currentTask: task({ state: 'finished', finishReason }),
    } as never);
  });
}

describe('useTerminalAgentOutput — 结束摘要与状态标签', () => {
  it('任务结束后打印摘要与继续提示，最后一行不是状态标签', () => {
    finishTask('第一次结束');

    const rendered = lines();
    expect(rendered).toContain('第一次结束');
    expect(rendered).toContain(t('terminal.agentContinuationHint'));
    expect(rendered[rendered.length - 1]).toBe(t('terminal.agentContinuationHint'));
    expect(plainText()).not.toContain(t('agent.states.thinking'));
  });

  it('同一任务被重新驱动后再次结束：摘要重新打印，终端不以「思考中」收尾', () => {
    finishTask('第一次结束');

    // 运行时被陈旧 sync 复活：结束态回到思考中
    act(() => {
      useAgentStore.setState({ agentState: 'thinking' } as never);
    });
    // 第二轮结束
    finishTask('第二次结束');

    const rendered = lines();
    expect(rendered).toContain('第一次结束');
    expect(rendered).toContain('第二次结束');
    // 关键：最后一屏不能停在那行「思考中」
    expect(rendered[rendered.length - 1]).toBe(t('terminal.agentContinuationHint'));
    expect(rendered.filter((line) => line.includes(t('agent.states.thinking'))).length).toBe(1);
  });

  it('同一任务结束后不再重复打印摘要', () => {
    finishTask('结束');
    const afterFirst = lines().filter((line) => line === '结束').length;

    // 结束态下的重复投影（例如 t / 终端实例版本变化）不应重复输出
    act(() => {
      useAgentStore.setState({ currentTask: task({ state: 'finished', finishReason: '结束' }) } as never);
    });

    expect(lines().filter((line) => line === '结束').length).toBe(afterFirst);
  });
});
