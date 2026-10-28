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

export type FooterAgentWaitingKind = 'answer' | 'approval';

/**
 * Agent 是不是在**等人**，而不是在干活。
 *
 * 真实反馈：Agent 回完一句问候，底栏一直挂「观察中」，用户以为它还在跑。
 * 真相是 `agentState` 的 `observing` 在整个代码库里只在两处被设置
 * （`agent-runtime` 的 `ask` 和 `approval` 分支），它从来不表示「观察命令输出」，
 * 就是「在等用户回答 / 等用户确认」。所以底栏不能照搬「观察中」这个含混词，
 * 得按 pending 状态显示「等待回答 / 等待确认」。
 *
 * 两者同时存在时审批优先：那时代码已经就绪，只差一个 yes/no，比补充信息更紧。
 */
export function resolveFooterAgentWaitingKind(input: {
  hasPendingApproval: boolean;
  hasPendingQuestion: boolean;
}): FooterAgentWaitingKind | null {
  if (input.hasPendingApproval) return 'approval';
  if (input.hasPendingQuestion) return 'answer';
  return null;
}

/** 任务已运行的整秒数。startTime 缺失或不合理时按 0 处理，不显示负数。 */
export function resolveFooterAgentElapsedSeconds(startTime: number | null, now: number): number {
  if (!startTime || !Number.isFinite(startTime)) return 0;
  return Math.max(0, Math.floor((now - startTime) / 1000));
}
