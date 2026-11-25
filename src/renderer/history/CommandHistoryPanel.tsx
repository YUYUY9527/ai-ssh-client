import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, Loader2, RefreshCw, Search, X } from 'lucide-react';

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
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  const handleToggle = useCallback(() => {
    if (show) {
      setShow(false);
      return;
    }
    setSearchQuery('');
    setShow(true);
  }, [show]);

  // 打开面板或切换活动会话时重新拉取当前服务器的历史命令
  useEffect(() => {
    if (!show) {
      return;
    }
    void loadHistory();
  }, [show, connectionId, loadHistory]);

  useLayoutEffect(() => {
    if (!show) {
      setPopoverPos(null);
      return;
    }
    const updatePosition = () => {
      const btn = triggerRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(448, window.innerWidth - margin * 2);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      const top = rect.bottom + 8;
      setPopoverPos({ left, top, width });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [show]);

  useEffect(() => {
    if (!show) {
      return;
    }
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setShow(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setShow(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
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
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className={`toolbar-button ${show ? 'toolbar-button-active' : ''}`}
        title={t('commandHistory.title')}
        aria-label={t('commandHistory.title')}
        aria-expanded={show}
      >
        <Clock className="h-4 w-4" />
      </button>

      {show && popoverPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="app-popover command-history-popover scrollbar-modern fixed top-auto z-overlay mt-0"
          style={{
            left: popoverPos.left,
            top: popoverPos.top,
            width: popoverPos.width,
          }}
        >
          <div className="app-popover-header shrink-0">
            <span className="shrink-0 whitespace-nowrap">{t('commandHistory.title')}</span>
            <span
              className="min-w-0 truncate text-[10px] font-normal normal-case tracking-normal opacity-70"
              title={connectionLabel}
            >
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
                className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-fg-subtle"
                autoFocus
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="icon-button h-5 w-5 shrink-0"
                  title={t('common.close')}
                  aria-label={t('common.close')}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
              <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
                {filteredEntries.length}
              </span>
            </div>
          </div>

          <div className="command-history-list scrollbar-modern p-1">
            {isLoading && entries.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin text-accent" />
                <span>{t('common.loading')}</span>
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
                      <span className="block truncate font-mono text-xs text-fg">
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
        </div>,
        document.body,
      )}
    </div>
  );
}
