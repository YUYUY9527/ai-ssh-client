import type { ReactNode } from 'react';
import { FileText, Loader2 } from 'lucide-react';

interface CommandStatus {
  command: string;
  status: 'pending' | 'success' | 'error';
  timestamp: number;
}

interface AppFooterProps {
  status: {
    icon: ReactNode;
    text: string;
    color: string;
  };
  commandStatus: CommandStatus | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** Footer status area for connection and command execution state. */
export function AppFooter({ status, commandStatus, translate }: AppFooterProps) {
  return (
    <footer className="app-footer">
      <div className="flex items-center gap-3">
        <div className={`flex items-center gap-2 ${status.color}`}>
          {status.icon}
          <span>{status.text}</span>
        </div>
        {commandStatus && (
          <div className={`flex items-center gap-1 ${
            commandStatus.status === 'pending' ? 'text-yellow-500' :
            commandStatus.status === 'success' ? 'text-green-500' : 'text-red-500'
          }`}
          >
            {commandStatus.status === 'pending' && <Loader2 className="w-3 h-3 animate-spin" />}
            {commandStatus.status === 'success' && <FileText className="w-3 h-3" />}
            <span className="truncate max-w-48">
              {commandStatus.status === 'pending'
                ? `... ${commandStatus.command}`
                : translate('commandStatus.completed')}
            </span>
          </div>
        )}
      </div>
      <span>AI SSH Client v1.2.0</span>
    </footer>
  );
}
