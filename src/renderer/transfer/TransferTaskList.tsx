import { AlertCircle, CheckCircle, Download, Upload, X } from 'lucide-react';

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
        {tasks.map((task) => (
          <div key={task.id} className="industrial-card p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 min-w-0">
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
            <div className="flex items-center gap-2">
              {task.status === 'transferring' && (
                <div className="flex-1 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-sm overflow-hidden">
                  <div
                    className="h-full bg-teal-500 rounded-sm transition-all"
                    style={{ width: `${task.progress}%` }}
                  />
                </div>
              )}
              {task.status === 'completed' && (
                <CheckCircle
                  className="w-4 h-4 text-green-500"
                  title={translate('common.success')}
                />
              )}
              {task.status === 'error' && (
                <span title={task.error} className="inline-flex">
                  <AlertCircle className="w-4 h-4 text-red-500" />
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
