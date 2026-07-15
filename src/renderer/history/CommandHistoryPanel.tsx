import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FolderOpen,
  RefreshCw,
  Search,
  Server,
  User,
} from 'lucide-react';

import { useConnectionStore } from '../store/useConnectionStore';
import { useSessionStore } from '../session/useSessionStore';
import { useI18n } from '../i18n';
import {
  DEFAULT_CWD,
  type CommandHistoryContext,
  type CommandHistoryHostNode,
  type CommandHistoryItemView,
} from './command-history-index';
import { useCommandHistoryStore } from './useCommandHistoryStore';

interface CommandHistoryPanelProps {
  onPasteCommand: (command: string) => void;
  activeSessionId?: string | null;
}

function quoteShellPath(path: string): string {
  if (/^[~/][A-Za-z0-9_./-]*$/.test(path)) {
    return path;
  }
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** Layered command history panel: host → username → cwd. */
export function CommandHistoryPanel({
  onPasteCommand,
  activeSessionId = null,
}: CommandHistoryPanelProps) {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [scopeToCurrent, setScopeToCurrent] = useState(true);
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [expandedCwds, setExpandedCwds] = useState<Set<string>>(new Set());
  const dropdownRef = useRef<HTMLDivElement>(null);
  const initializedExpansionRef = useRef(false);

  const loadHistory = useCommandHistoryStore((state) => state.loadHistory);
  const getTree = useCommandHistoryStore((state) => state.getTree);
  const query = useCommandHistoryStore((state) => state.query);
  const items = useCommandHistoryStore((state) => state.items);
  const isLoading = useCommandHistoryStore((state) => state.isLoading);

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

  const context = useMemo<CommandHistoryContext | undefined>(() => {
    if (!activeSession && !activeConnection) {
      return undefined;
    }
    return {
      host: activeConnection?.host,
      username: activeConnection?.username,
      cwd: activeSession?.cwd || DEFAULT_CWD,
      connectionId: activeSession?.connectionId || activeSessionId || undefined,
    };
  }, [activeConnection, activeSession, activeSessionId]);

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
    initializedExpansionRef.current = false;
    setShow(true);
  }, [loadHistory, show]);

  useEffect(() => {
    if (!show) return;

    const handleHistoryUpdated = () => {
      void loadHistory(true);
    };

    window.addEventListener('command-history-updated', handleHistoryUpdated);
    return () => window.removeEventListener('command-history-updated', handleHistoryUpdated);
  }, [loadHistory, show]);

  const tree = useMemo(
    () => getTree(context),
    // items/getTree ensure tree refreshes when store mutates
    [context, getTree, items],
  );

  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) {
      return [] as CommandHistoryItemView[];
    }
    return query({
      search: searchQuery,
      preferCurrentContext: true,
      context,
      limit: 80,
    });
  }, [context, query, searchQuery]);

  // 首次打开时展开当前上下文路径
  useEffect(() => {
    if (!show || initializedExpansionRef.current || tree.length === 0) {
      return;
    }

    const nextHosts = new Set<string>();
    const nextUsers = new Set<string>();
    const nextCwds = new Set<string>();

    const preferredHost = context?.host && tree.find((node) => node.host === context.host)
      ? context.host
      : tree[0]?.host;
    if (preferredHost) {
      nextHosts.add(preferredHost);
      const hostNode = tree.find((node) => node.host === preferredHost);
      const preferredUser = context?.username
        && hostNode?.usernames.some((node) => node.username === context.username)
        ? context.username
        : hostNode?.usernames[0]?.username;
      if (preferredUser) {
        const userKey = `${preferredHost}::${preferredUser}`;
        nextUsers.add(userKey);
        const userNode = hostNode?.usernames.find((node) => node.username === preferredUser);
        const preferredCwd = context?.cwd
          && userNode?.cwds.some((node) => node.cwd === context.cwd)
          ? context.cwd
          : userNode?.cwds[0]?.cwd;
        if (preferredCwd) {
          nextCwds.add(`${userKey}::${preferredCwd}`);
        }
      }
    }

    // 没有当前上下文时，默认展开最近一个 host/user/cwd
    if (nextHosts.size === 0 && tree[0]) {
      nextHosts.add(tree[0].host);
      if (tree[0].usernames[0]) {
        const userKey = `${tree[0].host}::${tree[0].usernames[0].username}`;
        nextUsers.add(userKey);
        if (tree[0].usernames[0].cwds[0]) {
          nextCwds.add(`${userKey}::${tree[0].usernames[0].cwds[0].cwd}`);
        }
      }
    }

    setExpandedHosts(nextHosts);
    setExpandedUsers(nextUsers);
    setExpandedCwds(nextCwds);
    initializedExpansionRef.current = true;
  }, [context, show, tree]);

  const visibleTree = useMemo(() => {
    if (!scopeToCurrent || !context?.host) {
      return tree;
    }
    const scoped = tree
      .filter((hostNode) => hostNode.host === context.host)
      .map((hostNode) => ({
        ...hostNode,
        usernames: hostNode.usernames
          .filter((userNode) => !context.username || userNode.username === context.username)
          .map((userNode) => ({
            ...userNode,
            cwds: context.cwd
              ? userNode.cwds.filter((cwdNode) => cwdNode.cwd === context.cwd)
              : userNode.cwds,
          }))
          .filter((userNode) => userNode.cwds.length > 0),
      }))
      .filter((hostNode) => hostNode.usernames.length > 0);

    // 当前上下文暂无记录时回退展示全部，避免空面板误导
    return scoped.length > 0 ? scoped : tree;
  }, [context, scopeToCurrent, tree]);

  const handlePaste = useCallback((command: string) => {
    onPasteCommand(command);
    setShow(false);
  }, [onPasteCommand]);

  const handleRerunInDir = useCallback((command: string, cwd: string) => {
    if ((window as any).writeToTerminal) {
      (window as any).writeToTerminal(`cd ${quoteShellPath(cwd)} && ${command}\r`);
    }
    setShow(false);
  }, []);

  const toggleHost = (host: string) => {
    setExpandedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(host)) next.delete(host);
      else next.add(host);
      return next;
    });
  };

  const toggleUser = (host: string, username: string) => {
    const key = `${host}::${username}`;
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleCwd = (host: string, username: string, cwd: string) => {
    const key = `${host}::${username}::${cwd}`;
    setExpandedCwds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderCommandRow = (item: CommandHistoryItemView, cwd: string) => (
    <div
      key={item.id}
      className="group mx-0.5 flex items-center gap-1 rounded-sm px-2 py-1.5 transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_68%,transparent)]"
    >
      <button
        onClick={() => handlePaste(item.command)}
        className="min-w-0 flex-1 text-left"
        title={item.command}
      >
        <div className="truncate font-mono text-xs text-slate-900 dark:text-white">
          {item.command}
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
          <span>
            {new Date(item.timestamp).toLocaleString(undefined, {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {item.connectionName && <span>· {item.connectionName}</span>}
          {item.executedBy === 'ai' && (
            <span className="rounded-sm bg-violet-500/15 px-1 text-violet-500">AI</span>
          )}
        </div>
      </button>
      {cwd && (
        <button
          onClick={() => handleRerunInDir(item.command, cwd)}
          className="hidden h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm border border-transparent text-slate-400 transition-colors hover:border-[color-mix(in_srgb,var(--accent-primary)_50%,var(--border-color))] hover:bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] hover:text-teal-500 group-hover:flex"
          title={`${t('commandHistory.rerunInDir')}: cd ${cwd} && ${item.command}`}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  const renderTree = (nodes: CommandHistoryHostNode[]) => (
    nodes.map((hostNode) => {
      const hostOpen = expandedHosts.has(hostNode.host);
      return (
        <div key={hostNode.host} className="mb-1.5">
          <button
            onClick={() => toggleHost(hostNode.host)}
            className="mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-sm border border-[color-mix(in_srgb,var(--border-color)_56%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_58%,var(--bg-secondary))] px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_50%,transparent)]"
          >
            {hostOpen ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
            <Server className="h-3 w-3 text-teal-500" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-800 dark:text-slate-100">
              {hostNode.host}
            </span>
            <span className="text-[10px] tabular-nums text-slate-400">
              {hostNode.commandCount}
            </span>
          </button>

          {hostOpen && hostNode.usernames.map((userNode) => {
            const userKey = `${hostNode.host}::${userNode.username}`;
            const userOpen = expandedUsers.has(userKey);
            return (
              <div key={userKey} className="ml-2">
                <button
                  onClick={() => toggleUser(hostNode.host, userNode.username)}
                  className="mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-sm px-2 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_50%,transparent)]"
                >
                  {userOpen ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
                  <User className="h-3 w-3 text-sky-500" />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-700 dark:text-slate-200">
                    {userNode.username}
                  </span>
                  <span className="text-[10px] tabular-nums text-slate-400">
                    {userNode.commandCount}
                  </span>
                </button>

                {userOpen && userNode.cwds.map((cwdNode) => {
                  const cwdKey = `${userKey}::${cwdNode.cwd}`;
                  const cwdOpen = expandedCwds.has(cwdKey);
                  const isCurrentCwd = Boolean(
                    context?.host === hostNode.host
                    && context?.username === userNode.username
                    && context?.cwd === cwdNode.cwd,
                  );
                  return (
                    <div key={cwdKey} className="ml-3">
                      <button
                        onClick={() => toggleCwd(hostNode.host, userNode.username, cwdNode.cwd)}
                        className={`mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-sm px-2 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--bg-hover)_50%,transparent)] ${
                          isCurrentCwd ? 'bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)]' : ''
                        }`}
                      >
                        {cwdOpen ? <ChevronDown className="h-3 w-3 text-slate-400" /> : <ChevronRight className="h-3 w-3 text-slate-400" />}
                        <FolderOpen className="h-3 w-3 text-amber-500" />
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-teal-600 dark:text-teal-400">
                          {cwdNode.cwd}
                        </span>
                        <span className="text-[10px] tabular-nums text-slate-400">
                          {cwdNode.commandCount}
                        </span>
                      </button>
                      {cwdOpen && (
                        <div className="mb-1 ml-2 border-l border-[color-mix(in_srgb,var(--border-color)_50%,transparent)] pl-1">
                          {cwdNode.commands.slice(0, 12).map((item) => renderCommandRow(item, cwdNode.cwd))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      );
    })
  );

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => void handleToggle()}
        className={`toolbar-button ${show ? 'toolbar-button-active' : ''}`}
        title={t('commandHistory.title')}
      >
        <Clock className="h-4 w-4" />
      </button>

      {show && (
        <div className="app-popover scrollbar-modern left-0 w-[28rem]">
          <div className="app-popover-header">
            <span>{t('commandHistory.title')}</span>
            <span className="text-[10px] font-normal normal-case tracking-normal opacity-60">
              host → username → cwd
            </span>
          </div>

          {context && (
            <div className="flex items-center justify-between gap-2 border-b border-[color-mix(in_srgb,var(--border-color)_60%,transparent)] px-3 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <div className="min-w-0 truncate">
                <span className="text-slate-600 dark:text-slate-300">{context.username || '?'}</span>
                <span className="mx-1">@</span>
                <span className="text-slate-600 dark:text-slate-300">{context.host || '?'}</span>
                <span className="mx-1">·</span>
                <span className="font-mono text-teal-600 dark:text-teal-400">{context.cwd || DEFAULT_CWD}</span>
              </div>
              <label className="flex shrink-0 cursor-pointer items-center gap-1">
                <input
                  type="checkbox"
                  checked={scopeToCurrent}
                  onChange={(e) => setScopeToCurrent(e.target.checked)}
                  className="h-3 w-3 accent-teal-500"
                />
                <span>{t('commandHistory.currentOnly')}</span>
              </label>
            </div>
          )}

          <div className="border-b border-[color-mix(in_srgb,var(--border-color)_60%,transparent)] px-2 py-1.5">
            <div className="flex items-center gap-1.5 rounded-sm border border-[color-mix(in_srgb,var(--border-color)_70%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_60%,transparent)] px-2 py-1">
              <Search className="h-3 w-3 flex-shrink-0 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('commandHistory.searchPlaceholder')}
                className="flex-1 bg-transparent text-xs text-slate-900 outline-none placeholder:text-slate-400 dark:text-white"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto p-1">
            {isLoading && items.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                {t('common.loading')}
              </div>
            ) : searchQuery.trim() ? (
              searchResults.length === 0 ? (
                <div className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  {t('commandHistory.noMatches')}
                </div>
              ) : (
                searchResults.map((item) => renderCommandRow(item, item.effectiveCwd))
              )
            ) : visibleTree.length === 0 ? (
              <div className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                {t('commandHistory.empty')}
              </div>
            ) : (
              renderTree(visibleTree)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
