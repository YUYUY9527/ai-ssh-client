import type { AgentState } from '../../shared/types';

/**
 * 底栏 Agent 状态的两个纯函数。
 *
 * 判定「有没有任务在本会话里跑」直接复用 `isAgentTaskRunningInSession`
 * （Esc 分流也用它），不再另写一份，免得两处条件慢慢漂移。
 * 这里只留显示层需要的东西：阶段名和已跑秒数。
 */

/** 状态条要显示的阶段名；返回 null 时用通用的「执行中」兜底。 */
export function resolveFooterAgentPhase(agentState: AgentState): AgentState | null {
  switch (agentState) {
    case 'thinking':
    case 'planning':
    case 'executing':
    case 'observing':
    case 'paused':
      return agentState;
    default:
      return null;
  }
}

/** 任务已运行的整秒数。startTime 缺失或不合理时按 0 处理，不显示负数。 */
export function resolveFooterAgentElapsedSeconds(startTime: number | null, now: number): number {
  if (!startTime || !Number.isFinite(startTime)) return 0;
  return Math.max(0, Math.floor((now - startTime) / 1000));
}
