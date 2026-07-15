import type { ReactNode } from 'react';
import { AlertCircle, FileText, FolderUp, Loader2 } from 'lucide-react';

interface CommandStatus {
  command: string;
  status: 'pending' | 'success' | 'error';
  timestamp: number;
}

interface TransferSummary {
  count: number;
  progress: number;
}

interface AppFooterProps {
  status: {
    icon: ReactNode;
    text: string;
    color: string;
  };
  commandStatus: CommandStatus | null;
  transferSummary?: TransferSummary | null;
  onOpenTransfers?: () => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** Footer status area for connection, transfer and command execution state. */
export function AppFooter({
  status,
  commandStatus,
  transferSummary,
  onOpenTransfers,
  translate,
}: AppFooterProps) {
  const commandStatusText = commandStatus?.status === 'pending'
    ? translate('commandStatus.running', { command: commandStatus.command })
    : commandStatus?.status === 'error'
    ? translate('commandStatus.failed')
    : translate('commandStatus.completed');

  const commandTone =
    commandStatus?.status === 'pending'
      ? 'text-warning'
      : commandStatus?.status === 'success'
      ? 'text-success'
      : 'text-danger';

  return (
    <footer className="app-footer">
      <div className="flex min-w-0 items-center gap-3">
        <div className={`app-footer-status shrink-0 ${status.color}`}>
          {status.icon}
          <span>{status.text}</span>
        </div>
        {transferSummary && (
          <button
            type="button"
            onClick={onOpenTransfers}
            className="app-footer-meta app-footer-transfer min-w-0"
            title={translate('fileTransfer.transferTasks')}
          >
            <FolderUp className="h-3 w-3 shrink-0" />
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="truncate">
              {translate('fileTransfer.activeTaskCount', { count: transferSummary.count })}
              {' · '}
              {transferSummary.progress}%
            </span>
          </button>
        )}
        {commandStatus && (
          <div className={`app-footer-meta min-w-0 ${commandTone}`}>
            {commandStatus.status === 'pending' && <Loader2 className="h-3 w-3 animate-spin" />}
            {commandStatus.status === 'success' && <FileText className="h-3 w-3" />}
            {commandStatus.status === 'error' && <AlertCircle className="h-3 w-3" />}
            <span className="max-w-48 truncate sm:max-w-72" title={commandStatus.command}>
              {commandStatusText}
            </span>
          </div>
        )}
      </div>
      <span className="shrink-0 opacity-80">AI SSH Client v{__APP_VERSION__}</span>
    </footer>
  );
}
