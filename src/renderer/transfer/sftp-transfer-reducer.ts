import type {
  SftpTransferEvent,
  SftpTransferStatus,
  SftpTransferTaskSnapshot,
} from '../../shared/ipc-types';

export type SftpTransferTaskMap = Record<string, SftpTransferTaskSnapshot>;

const TERMINAL_STATUSES: ReadonlySet<SftpTransferStatus> = new Set([
  'completed',
  'skipped',
  'canceled',
  'interrupted',
  'failed',
  'handed-off',
]);

/** 判断任务状态是否仍需要后端继续处理。 */
export function isSftpTransferActive(status: SftpTransferStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
}

/** 判断任务状态是否已经进入终态。 */
export function isSftpTransferTerminal(status: SftpTransferStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** 判断任务是否允许从前端列表移除。 */
export function canRemoveSftpTransfer(task: SftpTransferTaskSnapshot): boolean {
  return isSftpTransferTerminal(task.status);
}

/** 判断失败或取消的任务是否允许重试。 */
export function canRetrySftpTransfer(task: SftpTransferTaskSnapshot): boolean {
  return task.status === 'failed' || task.status === 'interrupted' || task.status === 'canceled';
}

/** 比较事件与当前快照的新旧关系。 */
function compareEventVersion(
  current: SftpTransferTaskSnapshot,
  attempt: number,
  sequence: number,
): number {
  if (attempt !== current.attempt) {
    return attempt - current.attempt;
  }
  return sequence - current.sequence;
}

/** 将后端快照按 attempt 与 sequence 合并到当前任务。 */
export function upsertSftpTransferSnapshot(
  current: SftpTransferTaskSnapshot | undefined,
  snapshot: SftpTransferTaskSnapshot,
): SftpTransferTaskSnapshot {
  if (!current) {
    return snapshot;
  }

  const version = compareEventVersion(current, snapshot.attempt, snapshot.sequence);
  if (version <= 0) {
    return current;
  }

  // 同一 attempt 已进入终态后不再接受状态回退；新 attempt 代表重试，可替换旧终态。
  if (snapshot.attempt === current.attempt && isSftpTransferTerminal(current.status)) {
    return current;
  }
  return snapshot;
}

/** 将单个有序事件应用到任务快照。 */
export function applySftpTransferEvent(
  current: SftpTransferTaskSnapshot | undefined,
  event: SftpTransferEvent,
): SftpTransferTaskSnapshot | undefined {
  if (event.type === 'snapshot') {
    // 事件外层版本为传输通道权威值，避免载荷字段不一致。
    const snapshot = {
      ...event.snapshot,
      taskId: event.taskId,
      connectionId: event.connectionId,
      attempt: event.attempt,
      sequence: event.sequence,
      updatedAt: event.timestamp,
    };
    return upsertSftpTransferSnapshot(current, snapshot);
  }

  // 增量事件必须依附同 taskId 的已有快照。
  if (!current || current.taskId !== event.taskId || current.connectionId !== event.connectionId) {
    return current;
  }

  const version = compareEventVersion(current, event.attempt, event.sequence);
  if (version <= 0 || event.attempt !== current.attempt) {
    return current;
  }

  // 同一 attempt 的终态是幂等屏障，忽略迟到事件和重复终态。
  if (isSftpTransferTerminal(current.status)) {
    return current;
  }

  if (event.type === 'progress') {
    const totalBytes = event.totalBytes ?? current.totalBytes;
    return {
      ...current,
      status: 'transferring',
      transferredBytes: Math.max(current.transferredBytes, event.transferredBytes),
      resumedFrom: current.resumedFrom,
      totalBytes,
      progress: Math.max(current.progress, Math.min(100, Math.max(0, event.progress))),
      sequence: event.sequence,
      updatedAt: event.timestamp,
      conflict: undefined,
    };
  }

  if (event.type === 'conflict') {
    return {
      ...current,
      status: 'waiting-conflict',
      conflict: event.conflict,
      sequence: event.sequence,
      updatedAt: event.timestamp,
    };
  }

  const completed = event.status === 'completed';
  return {
    ...current,
    status: event.status,
    transferredBytes: event.transferredBytes ?? current.transferredBytes,
    totalBytes: event.totalBytes ?? current.totalBytes,
    progress: completed ? 100 : (event.progress ?? current.progress),
    localPath: event.localPath ?? current.localPath,
    remotePath: event.remotePath ?? current.remotePath,
    error: event.error,
    commitGuarantee: event.commitGuarantee ?? current.commitGuarantee,
    conflict: undefined,
    sequence: event.sequence,
    updatedAt: event.timestamp,
    completedAt: event.timestamp,
  };
}

/** 在任务映射上应用事件，未命中任务的增量事件不会创建残缺快照。 */
export function reduceSftpTransferTasks(
  tasks: SftpTransferTaskMap,
  event: SftpTransferEvent,
): SftpTransferTaskMap {
  const current = tasks[event.taskId];
  const next = applySftpTransferEvent(current, event);
  if (!next || next === current) {
    return tasks;
  }
  return { ...tasks, [event.taskId]: next };
}
