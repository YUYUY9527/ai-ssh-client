import type { AgentState } from '../../../shared/types';

/**
 * 终端里那条 Agent 运行状态条该不该显示、显示什么阶段、跑了多久。
 *
 * 单独抽成纯函数是因为这里的判定条件比看上去多，而且每一条都有具体的
 * 误显示场景（别的标签页的任务、全屏程序里、已经结束的任务），
 * 塞在 JSX 里没法单独验。
 */

export interface TerminalAgentStatusInput {
  /** 本终端对应的会话。 */
  sessionId: string | null;
  /** 当前任务 id（无任务为 null）。 */
  taskId: string | null;
  /** 任务绑定的会话；老数据可能没有，视为本会话。 */
  taskConnectionId: string | null;
  /** 任务级状态（running/paused/finished/error…）。 */
  taskState: AgentState | null;
  /** 运行时阶段状态（thinking/executing/observing…）。 */
  agentState: AgentState;
  /** 远端处于全屏程序（vim/less/top）。 */
  isAlternateScreen: boolean;
}

/** 状态条可见性：不满足任何一条隐藏条件才算「在本终端里跑着」。 */
export function isTerminalAgentStatusVisible(input: TerminalAgentStatusInput): boolean {
  const {
    sessionId,
    taskId,
    taskConnectionId,
    taskState,
    agentState,
    isAlternateScreen,
  } = input;
  if (!sessionId || !taskId) return false;
  // 全屏程序自己占满屏幕，叠一条浮层只会挡住内容
  if (isAlternateScreen) return false;
  // 任务属于别的标签页：不要在这个终端里显示别人的进度
  if (taskConnectionId && taskConnectionId !== sessionId) return false;
  if (taskState === 'finished' || taskState === 'error') return false;
  if (agentState === 'finished' || agentState === 'error') return false;
  return true;
}

/** 状态条要显示的阶段名；返回 null 时用通用的「执行中」兜底。 */
export function resolveTerminalAgentStatusPhase(agentState: AgentState): AgentState | null {
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
export function resolveTerminalAgentElapsedSeconds(startTime: number | null, now: number): number {
  if (!startTime || !Number.isFinite(startTime)) return 0;
  return Math.max(0, Math.floor((now - startTime) / 1000));
}
