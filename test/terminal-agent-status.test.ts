import { describe, expect, it } from 'vitest';

import {
  isTerminalAgentStatusVisible,
  resolveTerminalAgentElapsedSeconds,
  resolveTerminalAgentStatusPhase,
  type TerminalAgentStatusInput,
} from '../src/renderer/session/terminal/terminal-agent-status';

/**
 * 终端里那条浮动状态条「什么时候该出现」。
 *
 * 用户反馈的第一条是「看不到当前的执行状态」，但状态条本身很容易被贴错：
 * 显示在别的标签页、盖在 vim 上、或者任务已经结束了还挂着。
 * 这些条件都写死在纯函数里，逐条锁住。
 */

const base: TerminalAgentStatusInput = {
  sessionId: 'session-a',
  taskId: 'task-1',
  taskConnectionId: 'session-a',
  taskState: 'thinking',
  agentState: 'executing',
  isAlternateScreen: false,
};

describe('Agent 状态条可见性', () => {
  it('本会话有任务在跑时显示', () => {
    expect(isTerminalAgentStatusVisible(base)).toBe(true);
  });

  it('任务属于别的标签页时不显示', () => {
    expect(isTerminalAgentStatusVisible({
      ...base,
      sessionId: 'session-b',
    })).toBe(false);
  });

  it('全屏程序（vim/less/top）里不显示，避免挡住内容', () => {
    expect(isTerminalAgentStatusVisible({ ...base, isAlternateScreen: true })).toBe(false);
  });

  it('任务已结束时不显示', () => {
    expect(isTerminalAgentStatusVisible({ ...base, taskState: 'finished' })).toBe(false);
    expect(isTerminalAgentStatusVisible({ ...base, taskState: 'error' })).toBe(false);
    // 任务级状态滞后但阶段状态已收尾，同样不该挂在那儿
    expect(isTerminalAgentStatusVisible({ ...base, agentState: 'finished' })).toBe(false);
  });

  it('没有任务或没有会话时不显示', () => {
    expect(isTerminalAgentStatusVisible({ ...base, taskId: null })).toBe(false);
    expect(isTerminalAgentStatusVisible({ ...base, sessionId: null })).toBe(false);
  });

  it('老任务记录没有 connectionId 时按本会话处理', () => {
    expect(isTerminalAgentStatusVisible({ ...base, taskConnectionId: null })).toBe(true);
  });
});

describe('Agent 状态条阶段名', () => {
  it('可展示的阶段原样返回', () => {
    expect(resolveTerminalAgentStatusPhase('thinking')).toBe('thinking');
    expect(resolveTerminalAgentStatusPhase('executing')).toBe('executing');
    expect(resolveTerminalAgentStatusPhase('observing')).toBe('observing');
    expect(resolveTerminalAgentStatusPhase('paused')).toBe('paused');
  });

  it('结束态与空闲没有阶段名（由调用方兜底成通用文案）', () => {
    expect(resolveTerminalAgentStatusPhase('finished')).toBeNull();
    expect(resolveTerminalAgentStatusPhase('error')).toBeNull();
    expect(resolveTerminalAgentStatusPhase('idle')).toBeNull();
  });
});

describe('Agent 状态条耗时秒数', () => {
  it('按整秒向下取整', () => {
    expect(resolveTerminalAgentElapsedSeconds(1_000_000, 1_004_900)).toBe(4);
  });

  it('时钟回拨时归零，不显示负数', () => {
    expect(resolveTerminalAgentElapsedSeconds(1_000_000, 999_000)).toBe(0);
  });

  it('缺少开始时刻时按 0 处理', () => {
    expect(resolveTerminalAgentElapsedSeconds(null, 1_000_000)).toBe(0);
    expect(resolveTerminalAgentElapsedSeconds(Number.NaN, 1_000_000)).toBe(0);
  });
});
