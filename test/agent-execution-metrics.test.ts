import { describe, it, expect } from 'vitest';

import { executionDurationMs, isExecutionFailure } from '../src/renderer/agent/agent-execution-metrics';
import type { AgentExecution } from '../src/shared/types';

/**
 * 真实回归：界面上每条命令都显示「耗时 0.0s」。
 *
 * 原因是耗时算的是 `execution.timestamp - step.timestamp`——两个时间戳分别由
 * 「决策步骤写入」和「执行记录写入」在本机同一轮同步中产生，差值恒为 ~0ms，
 * 与远端命令实际跑了多久完全无关。现在改为执行自身记录的 startedAt/completedAt。
 */
const baseExecution: AgentExecution = {
  id: 'exec-1',
  stepId: 'step-1',
  command: 'uptime',
  output: 'load average: 0.1',
  timestamp: 1_000_000,
  success: true,
  exitCode: 0,
};

describe('命令执行耗时', () => {
  it('优先使用执行自身的起止时刻', () => {
    const execution = { ...baseExecution, startedAt: 1_000_000, completedAt: 1_002_300 };
    expect(executionDurationMs(execution, 999_000)).toBe(2300);
  });

  it('历史记录没有起止时刻时回退到旧近似值', () => {
    const execution = { ...baseExecution, timestamp: 1_000_050 };
    expect(executionDurationMs(execution, 1_000_000)).toBe(50);
  });

  it('负值（时钟回拨/异常记录）归零，不显示负数耗时', () => {
    const execution = { ...baseExecution, startedAt: 1_000_500, completedAt: 1_000_000 };
    expect(executionDurationMs(execution, 1_000_400)).toBe(0);
    expect(executionDurationMs({ ...baseExecution }, 1_000_400)).toBe(0);
  });
});

describe('命令执行成败判定', () => {
  it('未捕获退出码时以 success 为准', () => {
    expect(isExecutionFailure({ ...baseExecution, exitCode: null, success: true })).toBe(false);
    expect(isExecutionFailure({ ...baseExecution, exitCode: null, success: false })).toBe(true);
  });

  it('捕获到非 0 退出码即失败', () => {
    expect(isExecutionFailure({ ...baseExecution, exitCode: 3, success: true })).toBe(true);
    expect(isExecutionFailure({ ...baseExecution, exitCode: 0, success: true })).toBe(false);
  });
});
