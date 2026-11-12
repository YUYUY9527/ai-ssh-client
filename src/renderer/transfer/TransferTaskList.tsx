import { useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  Clock3,
  Download,
  Gauge,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import type { SftpConflictPolicy } from '../../shared/ipc-types';
import type { SftpTransferTask } from '../store/useSftpTransferStore';
import {
  canPauseSftpTransfer,
  canResumeSftpTransfer,
  isSftpTransferActive,
  isSftpTransferTerminal,
} from './sftp-transfer-reducer';
import { formatByteSize, formatTransferSpeed, isSpeedDisplayable } from './transfer-speed';
import { useTransferSpeeds } from './useTransferSpeeds';

interface TransferTaskListProps {
  onCancelTask: (taskId: string) => void;
  onDiscardTask: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onResolveConflict: (
    taskId: string,
    policy: Exclude<SftpConflictPolicy, 'ask'>,
    renamedPath?: string,
    applyToBatch?: boolean,
  ) => void;
  onRetryTask: (taskId: string) => void;
  onPauseTask: (taskId: string) => void;
  onResumeTask: (taskId: string) => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  resolvingConflictTaskId?: string | null;
  tasks: SftpTransferTask[];
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** 格式化任务最后更新时间。 */
function formatUpdatedAt(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 将正式状态映射到展示文案键。 */
function getStatusKey(task: SftpTransferTask): string {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'skipped') return 'skipped';
  if (task.status === 'handed-off') return 'handedOff';
  if (task.status === 'canceled') return 'canceled';
  if (task.status === 'failed' || task.status === 'interrupted') return 'error';
  if (task.status === 'paused') return 'paused';
  if (task.status === 'canceling') return 'canceling';
  if (task.status === 'committing') return 'committing';
  if (task.status === 'waiting-conflict') return 'waitingConflict';
  if (task.status === 'queued' || task.status === 'checking') return 'pending';
  return 'transferring';
}

/** Displays transfer progress and task controls for the active SFTP session. */
export function TransferTaskList({
  onCancelTask,
  onDiscardTask,
  onRemoveTask,
  onResolveConflict,
  onRetryTask,
  onPauseTask,
  onResumeTask,
  onPauseAll,
  onResumeAll,
  resolvingConflictTaskId,
  tasks,
  translate,
}: TransferTaskListProps) {
  const [applyToBatch, setApplyToBatch] = useState(false);
  const speeds = useTransferSpeeds(tasks);
  const canPauseAll = tasks.some((task) => canPauseSftpTransfer(task));
  const canResumeAll = tasks.some((task) => canResumeSftpTransfer(task));
  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-fg-muted">
        <Download className="h-6 w-6 text-fg-subtle" />
        <p>{translate('fileTransfer.noTransferTasks')}</p>
      </div>
    );
  }

  return (
    <div className="file-transfer-scroll h-full w-full min-w-0 overflow-y-auto overflow-x-hidden bg-[color-mix(in_srgb,var(--bg-primary)_54%,var(--bg-secondary))]">
      <div className="flex items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] p-3">
        <h3 className="text-sm font-semibold text-fg dark:text-white">
          {translate('fileTransfer.transferTasks')}
        </h3>
        {(canPauseAll || canResumeAll) && (
          <div className="flex shrink-0 items-center gap-1">
            {canResumeAll && (
              <button
                type="button"
                onClick={onResumeAll}
                className="industrial-button-secondary inline-flex items-center gap-1 px-2 py-1 text-xs"
                title={translate('fileTransfer.resumeAll')}
              >
                <Play className="h-3 w-3" />
                {translate('fileTransfer.resumeAll')}
              </button>
            )}
            {canPauseAll && (
              <button
                type="button"
                onClick={onPauseAll}
                className="industrial-button-secondary inline-flex items-center gap-1 px-2 py-1 text-xs"
                title={translate('fileTransfer.pauseAll')}
              >
                <Pause className="h-3 w-3" />
                {translate('fileTransfer.pauseAll')}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 p-3">
        {tasks.map((task) => {
          const progressValue = Math.max(0, Math.min(100, task.status === 'completed' ? 100 : task.progress));
          const failed = task.status === 'failed' || task.status === 'interrupted' || task.status === 'canceled';
          const canCancel = isSftpTransferActive(task.status)
            && task.status !== 'committing'
            && task.status !== 'canceling';
          const canRetry = task.status === 'failed'
            || task.status === 'interrupted'
            || task.status === 'canceled'
            || task.status === 'skipped';
          const canPause = canPauseSftpTransfer(task);
          const canResume = canResumeSftpTransfer(task);
          const canRemove = isSftpTransferTerminal(task.status);
          const statusTone = task.status === 'completed' || task.status === 'handed-off'
            ? 'border-success bg-success-muted text-success dark:text-success-fg'
            : failed
            ? 'border-danger bg-danger-muted text-danger dark:text-danger-fg'
            : task.status === 'transferring' || task.status === 'committing'
            ? 'border-[color-mix(in_srgb,var(--accent-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] text-accent'
            : task.status === 'paused'
            ? 'border-line-strong bg-surface-raised text-fg-secondary'
            : 'border-warning bg-warning-muted text-warning dark:text-warning-fg';
          const progressTone = task.status === 'completed' || task.status === 'handed-off'
            ? 'bg-success'
            : failed
            ? 'bg-danger'
            : task.status === 'queued' || task.status === 'checking' || task.status === 'waiting-conflict'
            ? 'bg-warning'
            : task.status === 'paused'
            ? 'bg-[var(--text-muted)]'
            : 'bg-[var(--accent-primary)]';
          const statusKey = getStatusKey(task);

          return (
            <div key={task.taskId} className="industrial-card min-w-0 overflow-hidden p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  {task.direction === 'upload' ? (
                    <Upload className="h-3.5 w-3.5 flex-shrink-0 text-accent" />
                  ) : (
                    <Download className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                  )}
                  <span className="truncate text-sm text-fg-secondary" title={task.name}>
                    {task.name}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {canPause && (
                    <button
                      type="button"
                      onClick={() => onPauseTask(task.taskId)}
                      className="icon-button h-6 w-6"
                      title={translate('fileTransfer.pauseTask')}
                    >
                      <Pause className="h-3 w-3" />
                    </button>
                  )}
                  {canResume && (
                    <button
                      type="button"
                      onClick={() => onResumeTask(task.taskId)}
                      className="icon-button h-6 w-6"
                      title={translate('fileTransfer.resumeTask')}
                    >
                      <Play className="h-3 w-3" />
                    </button>
                  )}
                  {canCancel && (
                    <button
                      type="button"
                      onClick={() => onCancelTask(task.taskId)}
                      className="icon-button h-6 w-6"
                      title={translate('fileTransfer.cancelTask')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  {canRetry && (
                    <button
                      type="button"
                      onClick={() => onRetryTask(task.taskId)}
                      className="icon-button h-6 w-6"
                      title={translate('fileTransfer.retryTask')}
                    >
                      <RotateCcw className="h-3 w-3" />
                    </button>
                  )}
                  {canRemove && (
                    <>
                      <button
                        type="button"
                        onClick={() => onDiscardTask(task.taskId)}
                        className="icon-button h-6 w-6"
                        title={translate('fileTransfer.discardTask')}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveTask(task.taskId)}
                        className="icon-button h-6 w-6"
                        title={translate('common.close')}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs">
                <span className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 ${statusTone}`}>
                  {(task.status === 'completed' || task.status === 'handed-off') && <CheckCircle className="h-3 w-3" />}
                  {failed && <AlertCircle className="h-3 w-3" />}
                  {!isSftpTransferTerminal(task.status)
                    && task.status !== 'queued'
                    && task.status !== 'checking'
                    && task.status !== 'waiting-conflict'
                    && task.status !== 'paused'
                    && <Loader2 className="h-3 w-3 animate-spin" />}
                  {(task.status === 'queued' || task.status === 'checking' || task.status === 'waiting-conflict') && (
                    <Clock3 className="h-3 w-3" />
                  )}
                  {task.status === 'paused' && <Pause className="h-3 w-3" />}
                  {translate(`fileTransfer.taskStatus.${statusKey}`)}
                  {task.attempt > 1 ? ` #${task.attempt}` : ''}
                </span>
                <span className="tabular-nums text-fg-muted">
                  {progressValue}%
                </span>
              </div>

              <div className="h-1.5 overflow-hidden rounded-sm bg-surface-raised">
                <div
                  className={`h-full rounded-sm transition-all ${progressTone}`}
                  style={{ width: `${progressValue}%` }}
                />
              </div>

              {isSpeedDisplayable(task) && (
                <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2 text-[11px] tabular-nums">
                  <span className="inline-flex shrink-0 items-center gap-1 text-accent" title={translate('fileTransfer.transferSpeed')}>
                    <Gauge className="h-3 w-3" />
                    {formatTransferSpeed(speeds[task.taskId] ?? 0)}
                  </span>
                  <span className="truncate text-fg-muted">
                    {formatByteSize(task.transferredBytes)}
                    {task.totalBytes ? ` / ${formatByteSize(task.totalBytes)}` : ''}
                  </span>
                </div>
              )}

              {task.status === 'waiting-conflict' && (
                <div className="mt-3 rounded-sm border border-warning bg-warning-muted p-2.5">
                  <p className="break-words text-xs text-warning dark:text-warning-fg">
                    {translate('fileTransfer.conflictMessage', {
                      name: task.name,
                      path: task.conflict?.destinationPath || task.remotePath || '-',
                    })}
                  </p>
                  {task.batchId && (
                    <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-warning dark:text-warning-fg">
                      <input
                        type="checkbox"
                        checked={applyToBatch}
                        onChange={(event) => setApplyToBatch(event.target.checked)}
                        disabled={resolvingConflictTaskId === task.taskId}
                      />
                      <span>{translate('fileTransfer.conflictApplyBatch')}</span>
                    </label>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="industrial-button-secondary px-2 py-1 text-xs"
                      disabled={resolvingConflictTaskId === task.taskId}
                      onClick={() => onResolveConflict(task.taskId, 'overwrite', undefined, applyToBatch)}
                    >
                      {translate('fileTransfer.conflictOverwrite')}
                    </button>
                    <button
                      type="button"
                      className="industrial-button-secondary px-2 py-1 text-xs"
                      disabled={resolvingConflictTaskId === task.taskId}
                      onClick={() => onResolveConflict(task.taskId, 'skip', undefined, applyToBatch)}
                    >
                      {translate('fileTransfer.conflictSkip')}
                    </button>
                    <button
                      type="button"
                      className="industrial-button-secondary px-2 py-1 text-xs"
                      disabled={resolvingConflictTaskId === task.taskId}
                      onClick={() => onResolveConflict(
                        task.taskId,
                        'rename',
                        task.conflict?.suggestedName,
                        applyToBatch,
                      )}
                    >
                      {translate('fileTransfer.conflictRename')}
                    </button>
                  </div>
                </div>
              )}

              {(task.remotePath || task.localPath) && (
                <p
                  className="mt-2 truncate text-[11px] text-fg-muted"
                  title={task.remotePath || task.localPath}
                >
                  {task.direction === 'upload'
                    ? translate('fileTransfer.toRemote', { path: task.remotePath || '-' })
                    : translate('fileTransfer.fromRemote', { path: task.remotePath || task.name })}
                </p>
              )}

              <div className="mt-1 text-[11px] tabular-nums text-fg-subtle">
                {formatUpdatedAt(task.updatedAt)}
              </div>

              {task.notice && (
                <p className="mt-2 break-words text-xs text-warning dark:text-warning-fg" title={task.notice}>
                  {task.notice}
                </p>
              )}

              {failed && task.error?.message && (
                <p className="mt-2 line-clamp-2 break-words text-xs text-danger dark:text-danger-fg" title={task.error.message}>
                  {task.error.message}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
