import { AlertCircle, CheckCircle, Clock3, Download, Loader2, Upload, X } from 'lucide-react';

import type { SftpTransferTask } from '../store/useSftpTransferStore';

interface TransferTaskListProps {
  onRemoveTask: (taskId: string) => void;
  tasks: SftpTransferTask[];
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** Displays transfer progress for the active SFTP session. */
export function TransferTaskList({ onRemoveTask, tasks, translate }: TransferTaskListProps) {
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
      <div className="p-3 border-b border-[color-mix(in_srgb,var(--border-color)_76%,transparent)]">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
          {translate('fileTransfer.transferTasks')}
        </h3>
      </div>
      <div className="grid gap-2 p-3">
        {tasks.map((task) => {
          const progressValue = Math.max(0, Math.min(100, task.status === 'completed' ? 100 : task.progress));
          const statusTone = task.status === 'completed'
            ? 'border-green-500/40 bg-green-500/10 text-green-600 dark:text-green-400'
            : task.status === 'error'
            ? 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
            : task.status === 'transferring'
            ? 'border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-400'
            : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400';
          const progressTone = task.status === 'completed'
            ? 'bg-green-500'
            : task.status === 'error'
            ? 'bg-red-500'
            : task.status === 'pending'
            ? 'bg-amber-500'
            : 'bg-teal-500';

          return (
            <div key={task.id} className="industrial-card p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-1.5">
                  {task.type === 'upload' ? (
                    <Upload className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
                  ) : (
                    <Download className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                  )}
                  <span
                    className="truncate text-sm text-slate-700 dark:text-slate-300"
                    title={task.name}
                  >
                    {task.name}
                  </span>
                </div>
                <button
                  onClick={() => onRemoveTask(task.id)}
                  className="icon-button h-6 w-6"
                  title={translate('common.close')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>

              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 ${statusTone}`}>
                  {task.status === 'completed' && <CheckCircle className="h-3 w-3" />}
                  {task.status === 'error' && <AlertCircle className="h-3 w-3" />}
                  {task.status === 'transferring' && <Loader2 className="h-3 w-3 animate-spin" />}
                  {task.status === 'pending' && <Clock3 className="h-3 w-3" />}
                  {translate(`fileTransfer.taskStatus.${task.status}`)}
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

              {task.status === 'error' && task.error && (
                <p className="mt-2 line-clamp-2 text-xs text-red-600 dark:text-red-400" title={task.error}>
                  {task.error}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
