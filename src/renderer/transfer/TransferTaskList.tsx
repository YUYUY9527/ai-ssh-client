import {
  AlertCircle,
  CheckCircle,
  Clock3,
  Download,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import type { SftpTransferTask } from '../store/useSftpTransferStore';
import {
  isSftpTransferActive,
  isSftpTransferTerminal,
} from './sftp-transfer-reducer';

interface TransferTaskListProps {
  onCancelTask: (taskId: string) => void;
  onDiscardTask: (taskId: string) => void;
  onRemoveTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
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
  onRetryTask,
  tasks,
  translate,
}: TransferTaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-500 dark:text-slate-400">
        <Download className="h-6 w-6 text-slate-400" />
        <p>{translate('fileTransfer.noTransferTasks')}</p>
      </div>
    );
  }

  return (
    <div className="file-transfer-scroll h-full overflow-y-auto bg-[color-mix(in_srgb,var(--bg-primary)_54%,var(--bg-secondary))]">
      <div className="border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)] p-3">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
          {translate('fileTransfer.transferTasks')}
        </h3>
      </div>
      <div className="grid gap-2 p-3">
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
          const canRemove = isSftpTransferTerminal(task.status);
          const statusTone = task.status === 'completed' || task.status === 'handed-off'
            ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
            : failed
            ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
            : task.status === 'transferring' || task.status === 'committing'
            ? 'border-[color-mix(in_srgb,var(--accent-primary)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)] text-accent'
            : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400';
          const progressTone = task.status === 'completed' || task.status === 'handed-off'
            ? 'bg-green-500'
            : failed
            ? 'bg-red-500'
            : task.status === 'queued' || task.status === 'checking' || task.status === 'waiting-conflict'
            ? 'bg-amber-500'
            : 'bg-[var(--accent-primary)]';
          const statusKey = getStatusKey(task);

          return (
            <div key={task.taskId} className="industrial-card p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  {task.direction === 'upload' ? (
                    <Upload className="h-3.5 w-3.5 flex-shrink-0 text-teal-500" />
                  ) : (
                    <Download className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                  )}
                  <span className="truncate text-sm text-slate-700 dark:text-slate-300" title={task.name}>
                    {task.name}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
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

              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 ${statusTone}`}>
                  {(task.status === 'completed' || task.status === 'handed-off') && <CheckCircle className="h-3 w-3" />}
                  {failed && <AlertCircle className="h-3 w-3" />}
                  {!isSftpTransferTerminal(task.status)
                    && task.status !== 'queued'
                    && task.status !== 'checking'
                    && task.status !== 'waiting-conflict'
                    && <Loader2 className="h-3 w-3 animate-spin" />}
                  {(task.status === 'queued' || task.status === 'checking' || task.status === 'waiting-conflict') && (
                    <Clock3 className="h-3 w-3" />
                  )}
                  {translate(`fileTransfer.taskStatus.${statusKey}`)}
                  {task.attempt > 1 ? ` #${task.attempt}` : ''}
                </span>
                <span className="tabular-nums text-slate-500 dark:text-slate-400">
                  {progressValue}%
                </span>
              </div>

              <div className="h-1.5 overflow-hidden rounded-sm bg-slate-200 dark:bg-slate-700">
                <div
                  className={`h-full rounded-sm transition-all ${progressTone}`}
                  style={{ width: `${progressValue}%` }}
                />
              </div>

              {(task.remotePath || task.localPath) && (
                <p
                  className="mt-2 truncate text-[11px] text-slate-500 dark:text-slate-400"
                  title={task.remotePath || task.localPath}
                >
                  {task.direction === 'upload'
                    ? translate('fileTransfer.toRemote', { path: task.remotePath || '-' })
                    : translate('fileTransfer.fromRemote', { path: task.remotePath || task.name })}
                </p>
              )}

              <div className="mt-1 text-[11px] tabular-nums text-slate-400">
                {formatUpdatedAt(task.updatedAt)}
              </div>

              {failed && task.error?.message && (
                <p className="mt-2 line-clamp-2 text-xs text-red-600 dark:text-red-400" title={task.error.message}>
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
