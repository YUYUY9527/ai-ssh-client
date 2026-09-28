import type { AgentExecution } from '../../shared/types';

/**
 * 命令执行耗时（毫秒）。
 *
 * 真实回归：旧实现用 `execution.timestamp - step.timestamp`，而两个时间戳分别是
 * 「决策步骤写入」与「执行记录写入」，都发生在本机的同一轮同步里，因此界面恒定显示
 * 「耗时 0.0s」，完全测不到远端命令实际跑了多久。现在优先使用执行自身记录的
 * startedAt/completedAt；历史记录（无这两个字段）才回退到旧的近似值。
 */
export function executionDurationMs(execution: AgentExecution, stepTimestamp: number): number {
  if (execution.startedAt !== undefined && execution.completedAt !== undefined) {
    return Math.max(0, execution.completedAt - execution.startedAt);
  }
  return Math.max(0, execution.timestamp - stepTimestamp);
}

/** 是否失败：未捕获退出码时以 success 为准，捕获到非 0 退出码即失败。 */
export function isExecutionFailure(execution: AgentExecution): boolean {
  return !execution.success || (execution.exitCode ?? 0) !== 0;
}
