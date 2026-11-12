import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clock, RefreshCw, Search } from 'lucide-react';

import { useConnectionStore } from '../store/useConnectionStore';
import { useSessionStore } from '../session/useSessionStore';
import { useI18n } from '../i18n';
import {
  getSessionCommands,
  SESSION_COMMAND_UPDATED_EVENT,
  type SessionCommandEntry,
} from './session-command-buffer';
import { loadServerHistory, mergeHistorySources } from './server-history';

interface CommandHistoryPanelProps {
  onPasteCommand: (command: string) => void;
  activeSessionId?: string | null;
}

function formatHistoryTime(timestamp: number): string | null {
  if (!timestamp) {
    return null;
  }
  return new Date(timestamp).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 当前连接服务器的命令历史：服务器 ~/.bash_history + 本次会话内存记录。 */
export function CommandHistoryPanel({
  onPasteCommand,
  activeSessionId = null,
}: CommandHistoryPanelProps) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [entries, setEntries] = useState<SessionCommandEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeSession = useSessionStore((state) => (
    activeSessionId ? state.sessions[activeSessionId] : null
  ));
  const connections = useConnectionStore((state) => state.connections);

  const activeConnection = useMemo(() => {
    if (!activeSession) {
      return null;
    }
    return connections.find((item) => item.id === activeSession.connectionId) ?? null;
  }, [activeSession, connections]);

  const connectionId = activeSession?.connectionId ?? '';

  const loadHistory = useCallback(async () => {
    if (!connectionId) {
      setEntries([]);
      return;
    }
    setIsLoading(true);
    try {
      const sessionCommands = getSessionCommands(connectionId);
      const remoteCommands = await loadServerHistory(connectionId);
      setEntries(mergeHistorySources(sessionCommands, remoteCommands));
    } finally {
      setIsLoading(false);
    }
  }, [connectionId]);

  const handleToggle = useCallback(async () => {
    if (show) {
      setShow(false);
      return;
    }
    setSearchQuery('');
    setShow(true);
    await loadHistory();
  }, [loadHistory, show]);

  useEffect(() => {
    if (!show) {
      return;
    }
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShow(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [show]);

  useEffect(() => {
    if (!show) {
      return;
    }
    const handleSessionCommandUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string }>).detail;
      if (!detail?.connectionId || detail.connectionId === connectionId) {
        void loadHistory();
      }
    };
    window.addEventListener(SESSION_COMMAND_UPDATED_EVENT, handleSessionCommandUpdated);
    return () => window.removeEventListener(SESSION_COMMAND_UPDATED_EVENT, handleSessionCommandUpdated);
  }, [connectionId, loadHistory, show]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return entries;
    }
    return entries.filter((entry) => entry.command.toLowerCase().includes(query));
  }, [entries, searchQuery]);

  const handlePaste = useCallback((command: string) => {
    onPasteCommand(command);
    setShow(false);
  }, [onPasteCommand]);

  const connectionLabel = activeConnection
    ? `${activeConnection.username}@${activeConnection.host}`
    : activeSession?.title || t('commandHistory.currentServer');

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => void handleToggle()}
        className={`toolbar-button ${show ? 'toolbar-button-active' : ''}`}
        title={t('commandHistory.title')}
        aria-label={t('commandHistory.title')}
      >
        <Clock className="h-4 w-4" />
      </button>

      {show && (
        <div className="app-popover command-history-popover scrollbar-modern left-0 w-[28rem]">
          <div className="app-popover-header shrink-0">
            <span>{t('commandHistory.title')}</span>
            <span className="min-w-0 truncate text-[10px] font-normal normal-case tracking-normal opacity-60">
              {connectionLabel}
            </span>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="icon-button ml-auto h-6 w-6 shrink-0"
              title={t('commandHistory.refresh')}
              aria-label={t('commandHistory.refresh')}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="shrink-0 border-b border-[color-mix(in_srgb,var(--border-color)_60%,transparent)] px-2 py-1.5">
            <div className="flex items-center gap-1.5 rounded-sm border border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_60%,transparent)] px-2 py-1">
              <Search className="h-3 w-3 flex-shrink-0 text-fg-subtle" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('commandHistory.searchPlaceholder')}
                className="flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle dark:text-white"
                autoFocus
              />
              <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
                {filteredEntries.length}
              </span>
            </div>
          </div>

          <div className="command-history-list scrollbar-modern p-1">
            {isLoading && entries.length === 0 ? (
              <div className="py-6 text-center text-sm text-fg-muted">
                {t('common.loading')}
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="py-6 text-center text-sm text-fg-muted">
                {searchQuery.trim() ? t('commandHistory.noMatches') : t('commandHistory.empty')}
              </div>
            ) : (
              filteredEntries.map((entry) => {
                const timeText = formatHistoryTime(entry.timestamp);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => handlePaste(entry.command)}
                    className="group mx-0.5 flex w-[calc(100%-0.25rem)] items-center gap-2 rounded-sm px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
                    title={entry.command}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-fg dark:text-white">
                        {entry.command}
                      </span>
                      {(timeText || entry.executedBy === 'ai') && (
                        <span className="mt-0.5 flex items-center gap-1 text-[10px] text-fg-muted">
                          {timeText && <span>{timeText}</span>}
                          {entry.executedBy === 'ai' && (
                            <span className="rounded-sm bg-accent-alt-muted px-1 text-accent-alt">AI</span>
                          )}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
