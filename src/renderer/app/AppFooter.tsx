import type { ReactNode } from 'react';
import { AlertCircle, FileText, FolderUp, Loader2 } from 'lucide-react';

import { FooterAgentStatus } from './FooterAgentStatus';
import { FooterServerMonitor } from './FooterServerMonitor';

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
      ? 'text-warning-fg'
      : commandStatus?.status === 'success'
      ? 'text-success-fg'
      : 'text-danger-fg';

  return (
    <footer className="app-footer">
      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
        <div className={`app-footer-status shrink-0 ${status.color}`}>
          {status.icon}
          <span>{status.text}</span>
        </div>
        <FooterAgentStatus />
        {transferSummary && (
          <button
            type="button"
            onClick={onOpenTransfers}
            className="app-footer-meta app-footer-transfer min-w-0 gap-1.5 rounded-sm px-1.5 py-0.5 hover:bg-surface-hover"
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
            {commandStatus.status === 'pending' && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
            {commandStatus.status === 'success' && <FileText className="h-3 w-3 shrink-0" />}
            {commandStatus.status === 'error' && <AlertCircle className="h-3 w-3 shrink-0" />}
            <span className="max-w-48 truncate sm:max-w-72" title={commandStatus.command}>
              {commandStatusText}
            </span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 shrink-0 items-center justify-end gap-3 overflow-hidden">
        <div className="hidden min-w-0 overflow-hidden md:block">
          <FooterServerMonitor />
        </div>
      </div>
    </footer>
  );
}
