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
    isTaskInterrupted,
  });
  return null;
}

/** 当前「被用户 Esc 中断过」的任务 id（null = 没有）。 */
let interruptedTaskId: string | null = null;
function isTaskInterrupted(taskId: string): boolean {
  return interruptedTaskId === taskId;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  writes.length = 0;
  interruptedTaskId = null;
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

  /**
   * 「看不到当前执行状态」的直接来源：终端里只有一串 `$ cmd` 和它们的输出，
   * 哪条失败、每条跑了多久都看不出来。这里锁住每条命令的结局行。
   */
  it('每条命令打完就打印结局行（成败 + 退出码 + 真实耗时）', () => {
    act(() => {
      useAgentStore.setState({
        agentState: 'executing',
        currentTask: task({
          state: 'executing',
          thinkingSteps: [{
            id: 'step-1',
            type: 'execution',
            title: '',
            content: '命令：uptime',
            timestamp: 1_000_000,
            status: 'completed',
          }],
          executions: [{
            id: 'exec-1',
            stepId: 'step-1',
            command: 'uptime',
            output: 'up 3 days',
            timestamp: 1_001_000,
            success: true,
            exitCode: 0,
            startedAt: 1_001_000,
            completedAt: 1_003_400,
          }],
        }),
      } as never);
    });

    const resultLine = t('terminal.agentExecutionResult', {
      mark: '✓',
      status: t('agent.execution.exitCode', { code: 0 }),
      duration: '2.4',
    });
    const rendered = lines();
    expect(rendered).toContain('$ uptime');
    expect(rendered).toContain(resultLine);

    // 顺序：`$ cmd` → 结局行 → 结束摘要。反过来的话用户会先看到总结论，
    // 再看到某条命令其实失败了。
    finishTask('全部完成');
    const ordered = lines();
    expect(ordered.indexOf('$ uptime')).toBeLessThan(ordered.indexOf(resultLine));
    expect(ordered.indexOf(resultLine)).toBeLessThan(ordered.indexOf('全部完成'));
  });

  it('非 0 退出码标成失败', () => {
    act(() => {
      useAgentStore.setState({
        agentState: 'executing',
        currentTask: task({
          state: 'executing',
          executions: [{
            id: 'exec-2',
            stepId: 'step-2',
            command: 'cat /nope',
            output: 'No such file',
            timestamp: 1_001_000,
            success: false,
            exitCode: 1,
            startedAt: 1_001_000,
            completedAt: 1_001_200,
          }],
        }),
      } as never);
    });

    expect(lines()).toContain(t('terminal.agentExecutionResult', {
      mark: '✗',
      status: t('agent.execution.exitCode', { code: 1 }),
      duration: '0.2',
    }));
  });

  it('同一条执行记录不会重复打印结局行', () => {
    const currentTask = task({
      state: 'executing',
      executions: [{
        id: 'exec-3',
        stepId: 'step-3',
        command: 'free -h',
        output: 'Mem:',
        timestamp: 1_001_000,
        success: true,
        exitCode: 0,
      }],
    });
    act(() => {
      useAgentStore.setState({ agentState: 'executing', currentTask } as never);
    });
    const first = lines().filter((line) => line.startsWith('✓')).length;

    act(() => {
      useAgentStore.setState({ agentState: 'observing', currentTask } as never);
    });

    expect(lines().filter((line) => line.startsWith('✓')).length).toBe(first);
  });

  it('未捕获退出码时退回「执行结束/执行失败」，不显示 undefined', () => {
    act(() => {
      useAgentStore.setState({
        agentState: 'executing',
        currentTask: task({
          state: 'executing',
          executions: [{
            id: 'exec-4',
            stepId: 'step-4',
            command: 'long-running-job',
            output: '',
            timestamp: 1_001_000,
            success: true,
            exitCode: null,
          }, {
            id: 'exec-5',
            stepId: 'step-5',
            command: 'broken',
            output: '',
            timestamp: 1_001_500,
            success: false,
            exitCode: null,
          }],
        }),
      } as never);
    });

    const rendered = lines();
    expect(rendered).toContain(t('terminal.agentExecutionResult', {
      mark: '✓',
      status: t('agent.execution.completed'),
      duration: '0.0',
    }));
    expect(rendered).toContain(t('terminal.agentExecutionResult', {
      mark: '✗',
      status: t('agent.execution.failed'),
      duration: '0.0',
    }));
    expect(plainText()).not.toContain('undefined');
    expect(plainText()).not.toContain('null');
  });

  /**
   * Esc 中断走的是 store 的 cancelTask()，会把 finishReason 写成英文
   * `Task cancelled by user`，状态却是 finished（绿色）。照着打就变成
   * 「一条英文的成功结论 + 继续追问提示」，而连续对话早已收起。
   */
  it('被用户中断的任务打印中文中断提示，不提示继续追问', () => {
    interruptedTaskId = 'task-1';
    finishTask('Task cancelled by user');

    const rendered = lines();
    expect(rendered).toContain(t('terminal.agentInterrupted'));
    expect(rendered).not.toContain('Task cancelled by user');
    expect(rendered).not.toContain(t('terminal.agentContinuationHint'));
  });
});
