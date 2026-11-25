import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Clock, Copy, CornerDownLeft, Loader2, RefreshCw, Search, Sparkles, X } from 'lucide-react';

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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setCopiedId(null);
    setShow(true);
  }, [show]);

  useEffect(() => () => {
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
  }, []);

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

  const handleCopy = useCallback(async (entry: SessionCommandEntry) => {
    try {
      await navigator.clipboard.writeText(entry.command);
      setCopiedId(entry.id);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        setCopiedId((current) => (current === entry.id ? null : current));
      }, 1500);
    } catch {
      // 浏览器可能限制剪贴板权限，忽略即可
    }
  }, []);

  const connectionLabel = activeConnection
    ? `${activeConnection.username}@${activeConnection.host}`
    : activeSession?.title || t('commandHistory.currentServer');

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className={`toolbar-button whitespace-nowrap ${show ? 'toolbar-button-active' : ''}`}
        title={t('commandHistory.title')}
        aria-label={t('commandHistory.title')}
        aria-expanded={show}
      >
        <Clock className="h-4 w-4 shrink-0" />
        <span className="hidden md:inline">{t('commandHistory.history')}</span>
      </button>

      {show && popoverPos && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="app-popover header-popover command-history-popover fixed top-auto z-overlay mt-0"
          style={{
            left: popoverPos.left,
            top: popoverPos.top,
            width: popoverPos.width,
          }}
        >
          <div className="header-popover-header">
            <div className="header-popover-title-wrap">
              <span className="header-popover-icon">
                <Clock className="h-3.5 w-3.5" />
              </span>
              <span className="header-popover-title">{t('commandHistory.title')}</span>
              <span className="header-popover-pill" title={connectionLabel}>
                {connectionLabel}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void loadHistory()}
              className="icon-button h-7 w-7 shrink-0"
              title={t('commandHistory.refresh')}
              aria-label={t('commandHistory.refresh')}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="header-popover-search-bar">
            <div className="header-popover-search">
              <Search className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
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
              <span className="header-popover-count">
                {searchQuery.trim() ? `${filteredEntries.length}/${entries.length}` : entries.length}
              </span>
            </div>
          </div>

          <div className="command-history-list scrollbar-modern p-1.5">
            {isLoading && entries.length === 0 ? (
              <div className="header-popover-empty">
                <span className="header-popover-empty-icon">
                  <Loader2 className="h-4 w-4 animate-spin text-accent" />
                </span>
                <span className="text-xs text-fg-muted">{t('common.loading')}</span>
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="header-popover-empty">
                <span className="header-popover-empty-icon">
                  {searchQuery.trim() ? <Search className="h-4 w-4" /> : <Clock className="h-4 w-4" />}
                </span>
                <p className="text-xs text-fg-muted">
                  {searchQuery.trim() ? t('commandHistory.noMatches') : t('commandHistory.empty')}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {filteredEntries.map((entry) => {
                  const timeText = formatHistoryTime(entry.timestamp);
                  const copied = copiedId === entry.id;
                  return (
                    <div
                      key={entry.id}
                      className="header-popover-item group py-1.5"
                    >
                      <button
                        type="button"
                        onClick={() => handlePaste(entry.command)}
                        className="flex min-w-0 flex-1 items-start gap-2 text-left"
                        title={entry.command}
                      >
                        <span className="mt-0.5 shrink-0 select-none font-mono text-[11px] text-accent">$</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-mono text-[12px] leading-5 text-fg">
                            {entry.command}
                          </span>
                          {(timeText || entry.executedBy === 'ai') && (
                            <span className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-fg-subtle">
                              {timeText && <span className="tabular-nums">{timeText}</span>}
                              {entry.executedBy === 'ai' && (
                                <span className="inline-flex items-center gap-0.5 rounded-sm bg-accent-alt-muted px-1.5 py-0.5 text-[10px] font-medium leading-none text-accent-alt">
                                  <Sparkles className="h-2.5 w-2.5" />
                                  AI
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCopy(entry);
                          }}
                          className="icon-button h-6 w-6"
                          title={copied ? t('commandHistory.copied') : t('common.copy')}
                          aria-label={copied ? t('commandHistory.copied') : t('common.copy')}
                        >
                          {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => handlePaste(entry.command)}
                          className="icon-button h-6 w-6 text-accent hover:text-accent-hover"
                          title={t('commandHistory.clickToPaste')}
                          aria-label={t('commandHistory.clickToPaste')}
                        >
                          <CornerDownLeft className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {filteredEntries.length > 0 && (
            <div className="header-popover-footer text-[11px] text-fg-subtle">
              <span className="flex items-center gap-1.5">
                <CornerDownLeft className="h-3 w-3 text-accent" />
                {t('commandHistory.clickToPaste')}
              </span>
              <span className="font-mono text-[10.5px] tabular-nums text-fg-muted">
                {filteredEntries.length}
              </span>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
