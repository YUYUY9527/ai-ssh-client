import { useWorkspaceStore } from '../../workspace/useWorkspaceStore';
import { collectLeaves } from '../../workspace/paneLayout';
import { useSessionStore } from '../useSessionStore';

/**
 * 终端命令广播：把当前分屏可见面板上键入的按键，同步发到其它可见面板。
 *
 * 只作用于「屏幕上同时显示」的终端（分屏时的叶子面板），不会发给后台标签，
 * 避免误操作到看不见的会话。广播状态是全局开关，由终端工具栏切换。
 */

let enabled = false;
const listeners = new Set<(value: boolean) => void>();

export function isTerminalBroadcastEnabled(): boolean {
  return enabled;
}

export function setTerminalBroadcastEnabled(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  for (const listener of listeners) listener(value);
}

export function subscribeTerminalBroadcast(listener: (value: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 纯函数：从可见会话里挑出要同步的其它会话（去重、排除当前会话）。 */
export function pickBroadcastTargets(
  visibleSessionIds: string[],
  sessions: Record<string, { connectionId?: string | null } | undefined>,
  excludeConnectionId?: string,
): string[] {
  const result: string[] = [];
  for (const sessionId of visibleSessionIds) {
    const connectionId = sessions[sessionId]?.connectionId;
    if (!connectionId) continue;
    if (connectionId === excludeConnectionId) continue;
    if (!result.includes(connectionId)) result.push(connectionId);
  }
  return result;
}

/** 当前分屏可见的会话 id：分屏时取所有叶子，否则只有活动会话。 */
export function getVisibleSessionIds(): string[] {
  const workspace = useWorkspaceStore.getState();
  if (workspace.paneRoot) {
    const leaves = collectLeaves(workspace.paneRoot);
    if (leaves.length > 0) return leaves;
  }
  const active = useSessionStore.getState().activeSessionId;
  return active ? [active] : [];
}

export function getBroadcastTargetConnectionIds(excludeConnectionId?: string): string[] {
  const sessions = useSessionStore.getState().sessions;
  return pickBroadcastTargets(getVisibleSessionIds(), sessions, excludeConnectionId);
}
