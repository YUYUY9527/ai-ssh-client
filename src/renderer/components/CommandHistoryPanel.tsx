import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Clock, RefreshCw, Search } from 'lucide-react';
import type { CommandHistoryItem } from '../../shared/types';
import { buildCommandHistoryIndex } from '../history/command-history-index';
import { useCommandHistoryStore } from '../history/useCommandHistoryStore';

interface CommandHistoryPanelProps {
  onPasteCommand: (command: string) => void;
}

type HistoryItemWithEffectiveCwd = CommandHistoryItem & {
  effectiveCwd: string;
};

function normalizeTrackedPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '~') {
    return '~';
  }

  const isHomePath = trimmed.startsWith('~/');
  const isAbsolutePath = trimmed.startsWith('/');
  if (!isHomePath && !isAbsolutePath) {
    return trimmed;
  }

  const prefix = isHomePath ? '~' : '/';
  const rawSegments = (isHomePath ? trimmed.slice(2) : trimmed.slice(1)).split('/');
  const segments: string[] = [];

  rawSegments.forEach((segment) => {
    if (!segment || segment === '.') {
      return;
    }
    if (segment === '..') {
      segments.pop();
      return;
    }
    segments.push(segment);
  });

  if (prefix === '~') {
    return segments.length > 0 ? `~/${segments.join('/')}` : '~';
  }

  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

function resolveTrackedCwd(currentCwd: string, target: string): string | null {
  const sanitized = target.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (!sanitized || sanitized === '~') {
    return '~';
  }
  if (sanitized === '-') {
    return null;
  }
  if (sanitized.startsWith('/')) {
    return normalizeTrackedPath(sanitized);
  }
  if (sanitized.startsWith('~/')) {
    return normalizeTrackedPath(sanitized);
  }

  const base = normalizeTrackedPath(currentCwd || '~');
  if (base === '~') {
    return normalizeTrackedPath(`~/${sanitized}`);
  }
  return normalizeTrackedPath(`${base.replace(/\/$/, '')}/${sanitized}`);
}

function nextTrackedCwd(currentCwd: string, command: string): string | null {
  const match = command.trim().match(/^cd(?:\s+(.+))?$/);
  if (!match) {
    return null;
  }

  return resolveTrackedCwd(currentCwd, match[1] ?? '~');
}

function deriveEffectiveCwds(historyList: CommandHistoryItem[]): HistoryItemWithEffectiveCwd[] {
  const cwdByConnection = new Map<string, string>();
  const chronological = [...historyList].reverse();

  const derived = chronological.map((item) => {
    const connectionKey = item.connectionId || item.connectionName || item.id;
    const knownCwd = cwdByConnection.get(connectionKey);
    const storedCwd = item.cwd?.trim();
    const effectiveCwd = (!storedCwd || storedCwd === '~') && knownCwd
      ? knownCwd
      : (storedCwd || knownCwd || '~');

    const nextCwd = nextTrackedCwd(effectiveCwd, item.command);
    if (nextCwd) {
      cwdByConnection.set(connectionKey, nextCwd);
    }

    return {
      ...item,
      effectiveCwd,
    };
  });

  return derived.reverse();
}

export function CommandHistoryPanel({ onPasteCommand }: CommandHistoryPanelProps) {
  const [show, setShow] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const historyList = useCommandHistoryStore((state) => state.items);
  const loadHistory = useCommandHistoryStore((state) => state.loadHistory);

  // 点击外部关闭
  useEffect(() => {
    if (!show) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShow(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [show]);

  const handleToggle = useCallback(async () => {
    if (show) {
      setShow(false);
      return;
    }
    await loadHistory();
    setSearchQuery('');
    setShow(true);
  }, [loadHistory, show]);

  useEffect(() => {
    if (!show) return;

    const handleHistoryUpdated = () => {
      void loadHistory();
    };

    window.addEventListener('command-history-updated', handleHistoryUpdated);
    return () => window.removeEventListener('command-history-updated', handleHistoryUpdated);
  }, [loadHistory, show]);

  const handlePaste = useCallback((command: string) => {
    onPasteCommand(command);
    setShow(false);
  }, [onPasteCommand]);

  const handleRerunInDir = useCallback((command: string, cwd: string) => {
    if ((window as any).writeToTerminal) {
      (window as any).writeToTerminal(`cd ${cwd} && ${command}\r`);
    }
    setShow(false);
  }, []);

  const historyWithEffectiveCwd = useMemo(() => deriveEffectiveCwds(historyList), [historyList]);
  const groupedHistory = useMemo(
    () => buildCommandHistoryIndex(historyWithEffectiveCwd),
    [historyWithEffectiveCwd],
  );

  const filteredGroups = searchQuery
    ? groupedHistory
        .map((group) => ({
          ...group,
          commands: group.commands.filter((item) => (
            item.command.toLowerCase().includes(searchQuery.toLowerCase())
          )),
        }))
        .filter((group) => group.commands.length > 0)
    : groupedHistory;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={handleToggle}
        className={`toolbar-button ${show ? 'toolbar-button-active' : ''}`}
        title="历史命令"
      >
        <Clock className="w-4 h-4" />
      </button>

      {show && (
        <div className="app-popover scrollbar-modern left-0 w-96">
          <div className="app-popover-header">
            <span>历史命令</span>
            <span className="text-[10px] font-normal normal-case tracking-normal opacity-60">
              host → username → cwd
            </span>
          </div>

          {/* 搜索框 */}
          <div className="px-2 py-1.5 border-b border-[color-mix(in_srgb,var(--border-color)_60%,transparent)]">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-sm border border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_60%,transparent)]">
              <Search className="w-3 h-3 text-slate-400 flex-shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索命令..."
                className="flex-1 bg-transparent text-xs text-slate-900 dark:text-white outline-none placeholder:text-slate-400"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto p-1">
            {filteredGroups.length === 0 ? (
              <div className="text-center text-slate-500 dark:text-slate-400 text-sm py-4">
                {searchQuery ? '无匹配结果' : '暂无历史命令'}
              </div>
            ) : (
              filteredGroups.slice(0, 24).map((group) => (
                <div key={`${group.host}-${group.username}-${group.cwd}`} className="mb-2">
                  <div className="mx-1 mb-1 rounded-sm border border-[color-mix(in_srgb,var(--border-color)_56%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] px-2 py-1">
                    <div className="text-[10px] uppercase text-slate-500 dark:text-slate-400">
                      {group.host}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-slate-700 dark:text-slate-200">
                      <span>{group.username}</span>
                      <span className="text-slate-400">/</span>
                      <span className="font-mono text-teal-600 dark:text-teal-400">{group.cwd}</span>
                    </div>
                  </div>
                  {group.commands.slice(0, 8).map((item) => (
                    <div
                      key={item.id}
                      className="group flex items-center gap-1 mx-0.5 rounded-sm px-2 py-1.5 transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
                    >
                      <button
                        onClick={() => handlePaste(item.command)}
                        className="flex-1 text-left min-w-0"
                      >
                        <div className="font-mono text-xs text-slate-900 dark:text-white truncate">{item.command}</div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1">
                          <span>
                            {new Date(item.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {item.connectionName && <span>· {item.connectionName}</span>}
                        </div>
                      </button>
                      {item.effectiveCwd && (
                        <button
                          onClick={() => handleRerunInDir(item.command, item.effectiveCwd)}
                          className="hidden group-hover:flex flex-shrink-0 items-center justify-center h-6 w-6 rounded-sm border border-transparent hover:border-[color-mix(in_srgb,var(--accent-primary)_50%,var(--border-color))] hover:bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-slate-400 hover:text-teal-500 transition-colors"
                          title={`cd ${item.effectiveCwd} && ${item.command}`}
                        >
                          <RefreshCw className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
