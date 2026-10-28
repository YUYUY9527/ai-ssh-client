/**
 * @vitest-environment jsdom
 *
 * 底栏 Agent 运行状态（`FooterAgentStatus`）。
 *
 * 背景（真实反馈）：状态原来画在终端左下角的浮层上，压住了命令输出；
 * 现在挪到应用底栏、紧挨「已连接」。这里锁定几件容易回退的事：
 * 位置在连接状态右侧、别的标签页的任务不能在这里报进度、结束态要立刻消失、
 * 显示的阶段名取自运行时状态。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { AppFooter } from '../src/renderer/app/AppFooter';
import { FooterAgentStatus } from '../src/renderer/app/FooterAgentStatus';
import {
  resolveFooterAgentElapsedSeconds,
  resolveFooterAgentPhase,
  resolveFooterAgentWaitingKind,
} from '../src/renderer/app/footer-agent-status';
import { t } from '../src/renderer/i18n';
import { useAgentStore } from '../src/renderer/store/useAgentStore';
import type { AgentTask } from '../src/shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// AppFooter 右端的版本号由 Vite define 注入，测试环境补一个
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';

const SESSION_ID = 'conn-1';

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'task-1',
    connectionId: SESSION_ID,
    userInput: '看下磁盘',
    state: 'executing',
    thinkingSteps: [],
    executions: [],
    startTime: Date.now(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(node = createElement(FooterAgentStatus)) {
  act(() => { root.render(node); });
}

/** 底栏这一小块的全部文字（空字符串 = 没渲染）。 */
function text(): string {
  return (container.textContent || '').trim();
}

beforeEach(() => {
  useAgentStore.setState({
    activeConnectionId: SESSION_ID,
    currentTask: null,
    agentState: 'idle',
    pendingQuestion: null,
    pendingApproval: null,
  } as never);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('FooterAgentStatus — 什么时候出现', () => {
  it('没有任务时不占位置', () => {
    expect(text()).toBe('');
  });

  it('本会话有任务在跑时显示阶段与耗时', () => {
    act(() => {
      useAgentStore.setState({ currentTask: task(), agentState: 'executing' } as never);
    });

    expect(text()).toContain(t('agent.states.executing'));
    expect(text()).toContain('0s');
    // 中断提示在窄窗口收起，但标题里始终可查
    expect(container.querySelector('[title]')?.getAttribute('title'))
      .toContain(t('terminal.agentStatusEscapeHint'));
  });

  it('任务属于别的标签页时不显示', () => {
    act(() => {
      useAgentStore.setState({
        activeConnectionId: 'conn-2',
        currentTask: task({ connectionId: 'conn-1' }),
        agentState: 'executing',
      } as never);
    });

    expect(text()).toBe('');
  });

  it('任务结束后立刻消失，不留「执行中」', () => {
    act(() => {
      useAgentStore.setState({ currentTask: task(), agentState: 'executing' } as never);
    });
    expect(text()).toContain(t('agent.states.executing'));

    act(() => {
      useAgentStore.setState({
        currentTask: task({ state: 'finished' }),
        agentState: 'finished',
      } as never);
    });
    expect(text()).toBe('');
  });

  it('运行时状态是 paused 时如实显示已暂停', () => {
    act(() => {
      useAgentStore.setState({
        currentTask: task({ state: 'paused' }),
        agentState: 'paused',
      } as never);
    });

    expect(text()).toContain(t('agent.states.paused'));
  });

  it('等用户回答时显示「等待回答」，不显示「观察中」', () => {
    // 真实反馈：Agent 回完一句问候后底栏一直挂「观察中」，用户以为它还在跑。
    // 真相是 `ask` 分支把状态设成 observing，本质是在等你补充信息。
    act(() => {
      useAgentStore.setState({
        currentTask: task(),
        agentState: 'observing',
        pendingQuestion: '你好！请告诉我你希望完成的具体任务。',
      } as never);
    });

    expect(text()).toContain(t('terminal.agentStatusAwaitingAnswer'));
    expect(text()).not.toContain(t('agent.states.observing'));
  });

  it('等用户确认命令时显示「等待确认」', () => {
    act(() => {
      useAgentStore.setState({
        currentTask: task(),
        agentState: 'observing',
        pendingApproval: { command: 'rm -rf old', riskLevel: 'high' },
      } as never);
    });

    expect(text()).toContain(t('terminal.agentStatusAwaitingApproval'));
    expect(text()).not.toContain(t('agent.states.observing'));
  });

  it('无人可等时 observing 仍如实显示（兜底路径不受影响）', () => {
    act(() => {
      useAgentStore.setState({
        currentTask: task(),
        agentState: 'observing',
        pendingQuestion: null,
        pendingApproval: null,
      } as never);
    });

    expect(text()).toContain(t('agent.states.observing'));
  });
});

describe('AppFooter — Agent 状态的位置', () => {
  const status = { icon: null, text: '已连接', color: 'text-success' };

  function footerNode() {
    return createElement(AppFooter, {
      status,
      commandStatus: null,
      translate: t,
    } as never);
  }

  it('在连接状态右侧，且不与传输/命令状态抢位置', () => {
    act(() => {
      useAgentStore.setState({ currentTask: task(), agentState: 'executing' } as never);
    });
    render(footerNode());

    const connection = container.querySelector('.app-footer-status');
    const agent = container.querySelector('.app-footer-agent');
    expect(connection).not.toBeNull();
    expect(agent).not.toBeNull();
    // 同一行、且排在连接状态之后
    expect(connection!.compareDocumentPosition(agent!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('没有任务时底栏不出现 Agent 那一块', () => {
    render(footerNode());

    expect(container.querySelector('.app-footer-agent')).toBeNull();
  });
});

describe('底栏 Agent 阶段名', () => {
  it('可展示的阶段原样返回', () => {
    expect(resolveFooterAgentPhase('thinking')).toBe('thinking');
    expect(resolveFooterAgentPhase('executing')).toBe('executing');
    expect(resolveFooterAgentPhase('observing')).toBe('observing');
    expect(resolveFooterAgentPhase('paused')).toBe('paused');
  });

  it('结束态与空闲没有阶段名（由调用方兜底成通用文案）', () => {
    expect(resolveFooterAgentPhase('finished')).toBeNull();
    expect(resolveFooterAgentPhase('error')).toBeNull();
    expect(resolveFooterAgentPhase('idle')).toBeNull();
  });
});

describe('底栏 Agent 等待态', () => {
  it('有待回答问题 → 等待回答', () => {
    expect(resolveFooterAgentWaitingKind({ hasPendingApproval: false, hasPendingQuestion: true }))
      .toBe('answer');
  });

  it('有待审批命令 → 等待确认', () => {
    expect(resolveFooterAgentWaitingKind({ hasPendingApproval: true, hasPendingQuestion: false }))
      .toBe('approval');
  });

  it('两者同时存在时审批优先（只差一个 yes/no）', () => {
    expect(resolveFooterAgentWaitingKind({ hasPendingApproval: true, hasPendingQuestion: true }))
      .toBe('approval');
  });

  it('都没有 → 不是在等人，交给阶段名显示', () => {
    expect(resolveFooterAgentWaitingKind({ hasPendingApproval: false, hasPendingQuestion: false }))
      .toBeNull();
  });
});

describe('底栏 Agent 耗时秒数', () => {
  it('按整秒向下取整', () => {
    expect(resolveFooterAgentElapsedSeconds(1_000_000, 1_004_900)).toBe(4);
  });

  it('时钟回拨时归零，不显示负数', () => {
    expect(resolveFooterAgentElapsedSeconds(1_000_000, 999_000)).toBe(0);
  });

  it('缺少开始时刻时按 0 处理', () => {
    expect(resolveFooterAgentElapsedSeconds(null, 1_000_000)).toBe(0);
    expect(resolveFooterAgentElapsedSeconds(Number.NaN, 1_000_000)).toBe(0);
  });
});
