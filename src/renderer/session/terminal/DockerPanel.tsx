import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Box, Container, Layers3, Loader2, Play, RefreshCw, RotateCcw, ScrollText, Search, Square, TerminalSquare, X } from 'lucide-react';
import type { DockerContainerDetail, DockerContainerSummary } from '../../../shared/ipc-types';
import { DockerExecTerminal } from './DockerExecTerminal';
import { ConfirmDialog } from '../../shared-ui/ConfirmDialog';
import { getWebSftpClientId } from '../../lib/web';

interface DockerPanelProps {
  connectionId: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

type ActionKind = 'start' | 'stop' | 'restart';
type ContainerFilter = 'all' | 'running' | 'stopped';

/** 容器管理弹窗：列表 + 详情 + 启停/重启 + 日志 + 进入容器 shell。 */
export function DockerPanel({ connectionId, translate, onClose }: DockerPanelProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [version, setVersion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<ActionKind | null>(null);
  const [pendingAction, setPendingAction] = useState<{ container: DockerContainerSummary; action: ActionKind } | null>(null);
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [logs, setLogs] = useState<{ containerId: string; text: string } | null>(null);
  const [logSearch, setLogSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const logPreRef = useRef<HTMLPreElement | null>(null);
  const [execTarget, setExecTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [containerFilter, setContainerFilter] = useState<ContainerFilter>('all');

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.listDockerContainers;
    if (!api) {
      setAvailable(false);
      setError(translate('terminal.docker.unavailable'));
      return;
    }
    try {
      const result = await api(connectionId);
      if (result.success) {
        setAvailable(result.data.available);
        setVersion(result.data.version);
        setError(result.data.error || null);
        setContainers(result.data.containers || []);
      } else {
        setAvailable(false);
        setError(result.error || translate('terminal.docker.unavailable'));
      }
    } catch (caught) {
      setAvailable(false);
      setError(caught instanceof Error ? caught.message : translate('terminal.docker.unavailable'));
    }
  }, [connectionId, translate]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runAction = async (container: DockerContainerSummary, action: ActionKind) => {
    const api = window.electronAPI?.dockerContainerAction;
    if (!api) return;
    setBusyId(container.id);
    setBusyAction(action);
    try {
      const result = await api(connectionId, container.id, action);
      if (!result.success) setError(result.error || `${action} failed`);
      await refresh();
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const openDetail = async (container: DockerContainerSummary) => {
    const api = window.electronAPI?.inspectDockerContainer;
    if (!api) return;
    const result = await api(connectionId, container.id);
    if (result.success) setDetail(result.data);
    else setError(result.error || 'inspect failed');
  };

  const openLogs = (container: DockerContainerSummary) => {
    setLogSearch('');
    setFollow(true);
    setLogs({ containerId: container.id, text: '' });
  };

  // 真流式跟随：SSE 订阅 `docker logs -f`，新日志实时追加；暂停/关闭即断开连接冻结内容。
  const logContainerId = logs?.containerId ?? null;
  useEffect(() => {
    if (!logContainerId || !follow) return undefined;
    const params = new URLSearchParams({ tail: '500', clientId: getWebSftpClientId() });
    const source = new EventSource(
      `/api/ssh/${encodeURIComponent(connectionId)}/docker/containers/${encodeURIComponent(logContainerId)}/logs/stream?${params.toString()}`,
    );
    let disposed = false;
    source.addEventListener('log', (event) => {
      if (disposed) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { text?: string };
        if (!payload?.text) return;
        setLogs((current) =>
          current && current.containerId === logContainerId
            ? { containerId: logContainerId, text: current.text + payload.text }
            : current,
        );
      } catch {
        // 忽略无法解析的帧
      }
    });
    source.addEventListener('error', (event) => {
      if (disposed) return;
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { message?: string };
        if (payload?.message) setError(payload.message);
      } catch {
        // 服务端正常 end 或网络中断：EventSource 会自行重连，不额外提示
      }
    });
    return () => {
      disposed = true;
      source.close();
    };
  }, [logContainerId, follow, connectionId]);

  // 内容更新后（且处于跟随/首次打开）自动滚到最下方，显示最新日志。
  useEffect(() => {
    if (!logs || !follow) return;
    const pre = logPreRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [logs, follow]);

  // 用户向上滚动离开底部时自动暂停跟随，避免被定时刷新强行拽回底部。
  const handleLogScroll = () => {
    if (!follow) return;
    const pre = logPreRef.current;
    if (!pre) return;
    const distanceFromBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight;
    if (distanceFromBottom > 24) setFollow(false);
  };

  const visibleLogs = useMemo(() => {
    if (!logs) return '';
    const keyword = logSearch.trim().toLowerCase();
    if (!keyword) return logs.text;
    return logs.text
      .split('\n')
      .filter((line) => line.toLowerCase().includes(keyword))
      .join('\n');
  }, [logs, logSearch]);

  const runningCount = useMemo(() => containers.filter((item) => item.state === 'running').length, [containers]);
  const stoppedCount = containers.length - runningCount;

  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    return containers.filter((item) => {
      const matchesFilter = containerFilter === 'all'
        || (containerFilter === 'running' ? item.state === 'running' : item.state !== 'running');
      const matchesSearch = !keyword
        || item.name.toLowerCase().includes(keyword)
        || item.image.toLowerCase().includes(keyword)
        || item.state.toLowerCase().includes(keyword);
      return matchesFilter && matchesSearch;
    });
  }, [containers, filter, containerFilter]);

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="industrial-modal relative my-auto flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden">
        <div className="docker-panel-header shrink-0">
          <div className="flex min-w-0 items-center gap-3">
            <div className="docker-brand-mark"><Container className="h-5 w-5" /></div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h2 className="text-base font-semibold text-fg">{translate('terminal.docker.title')}</h2>
                {version ? <span className="docker-version">Docker {version}</span> : null}
              </div>
              <p className="mt-0.5 text-xs text-fg-muted">{translate('terminal.docker.subtitle')}</p>
            </div>
          </div>
          <div className="docker-panel-tools flex items-center gap-2">
            <label className="docker-search">
              <Search className="h-4 w-4 shrink-0 text-fg-muted" />
              <input
                aria-label={translate('terminal.docker.filterPlaceholder')}
                placeholder={translate('terminal.docker.filterPlaceholder')}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
              {filter ? (
                <button type="button" className="docker-search-clear" onClick={() => setFilter('')} title={translate('terminal.docker.clearSearch')}>
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </label>
            <button type="button" className="icon-button" onClick={() => { void refresh(); }} title={translate('terminal.docker.refresh')} aria-label={translate('terminal.docker.refresh')}>
              <RefreshCw className={`h-4 w-4 ${available === null ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" className="icon-button" onClick={onClose} title={translate('terminal.docker.close')} aria-label={translate('terminal.docker.close')}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {available === false ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="docker-unavailable-icon"><Container className="h-6 w-6" /></div>
            <div className="max-w-md">
              <div className="text-sm font-semibold text-fg">{translate('terminal.docker.unavailable')}</div>
              {error ? <p className="mt-1 text-xs leading-5 text-danger">{error}</p> : null}
              <p className="mt-1 text-xs leading-5 text-fg-muted">{translate('terminal.docker.unavailableHint')}</p>
            </div>
            <button type="button" className="toolbar-button" onClick={() => { void refresh(); }}>
              <RefreshCw className="h-3.5 w-3.5" />{translate('terminal.docker.retry')}
            </button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <div className="docker-panel-content">
              <div className="docker-overview">
                <button type="button" aria-pressed={containerFilter === 'all'} className={`docker-stat-tile ${containerFilter === 'all' ? 'is-active' : ''}`} onClick={() => setContainerFilter('all')}>
                  <span className="docker-stat-icon"><Layers3 className="h-4 w-4" /></span>
                  <span className="min-w-0"><span className="docker-stat-label">{translate('terminal.docker.total')}</span><span className="docker-stat-value">{containers.length}</span></span>
                </button>
                <button type="button" aria-pressed={containerFilter === 'running'} className={`docker-stat-tile is-running ${containerFilter === 'running' ? 'is-active' : ''}`} onClick={() => setContainerFilter('running')}>
                  <span className="docker-stat-icon"><Activity className="h-4 w-4" /></span>
                  <span className="min-w-0"><span className="docker-stat-label">{translate('terminal.docker.running')}</span><span className="docker-stat-value">{runningCount}</span></span>
                </button>
                <button type="button" aria-pressed={containerFilter === 'stopped'} className={`docker-stat-tile is-stopped ${containerFilter === 'stopped' ? 'is-active' : ''}`} onClick={() => setContainerFilter('stopped')}>
                  <span className="docker-stat-icon"><Box className="h-4 w-4" /></span>
                  <span className="min-w-0"><span className="docker-stat-label">{translate('terminal.docker.stopped')}</span><span className="docker-stat-value">{stoppedCount}</span></span>
                </button>
              </div>

              <div className="docker-list-heading">
                <div className="flex min-w-0 items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-fg">{translate('terminal.docker.instances')}</h3>
                  <span className="docker-count">{filtered.length} / {containers.length}</span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                  <span className="docker-live-dot" />{translate('terminal.docker.liveStatus')}
                </div>
              </div>

              <div className="docker-container-list">
                <div className="docker-container-labels">
                  <span>{translate('terminal.docker.name')}</span>
                  <span>{translate('terminal.docker.image')}</span>
                  <span>{translate('terminal.docker.ports')}</span>
                  <span>{translate('terminal.docker.state')}</span>
                  <span className="text-right">{translate('terminal.docker.actions')}</span>
                </div>
                {filtered.length === 0 ? (
                  <div className="docker-empty-state">
                    {available === null ? (
                      <><Loader2 className="h-5 w-5 animate-spin text-accent" /><span>{translate('terminal.docker.loading')}</span></>
                    ) : (
                      <><Box className="h-5 w-5" /><span>{filter || containerFilter !== 'all' ? translate('terminal.docker.noMatches') : translate('terminal.docker.empty')}</span></>
                    )}
                  </div>
                ) : filtered.map((container) => (
                  <div key={container.id} className="docker-container-row">
                    <div className="docker-identity">
                      <span className="docker-container-icon"><Container className="h-4 w-4" /></span>
                      <div className="min-w-0">
                        <button type="button" className="docker-container-name" onClick={() => { void openDetail(container); }} title={container.name}>
                          {container.name}
                        </button>
                        <div className="docker-container-id">{container.id.slice(0, 12)}</div>
                      </div>
                    </div>
                    <div className="docker-image-cell" title={container.image}>{container.image}</div>
                    <div className="docker-ports-cell" title={container.ports || translate('terminal.docker.noPorts')}>
                      <span className="docker-mobile-label">{translate('terminal.docker.ports')}</span>
                      <span className={container.ports ? '' : 'text-fg-subtle'}>{container.ports || translate('terminal.docker.noPorts')}</span>
                    </div>
                    <div className="docker-status-cell">
                      <span className={`docker-status ${container.state === 'running' ? 'is-running' : 'is-stopped'}`}>
                        <span className="docker-status-dot" />{container.state}
                      </span>
                      <span className="docker-runtime">{container.runningFor || container.status}</span>
                    </div>
                    <div className="docker-actions">
                      <button
                        type="button"
                        className="docker-action-button is-start"
                        disabled={busyId === container.id || container.state === 'running'}
                        title={translate('terminal.docker.start')}
                        aria-label={translate('terminal.docker.start')}
                        onClick={() => setPendingAction({ container, action: 'start' })}
                      >
                        {busyId === container.id && busyAction === 'start' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="docker-action-button is-stop"
                        disabled={busyId === container.id || container.state !== 'running'}
                        title={translate('terminal.docker.stop')}
                        aria-label={translate('terminal.docker.stop')}
                        onClick={() => setPendingAction({ container, action: 'stop' })}
                      >
                        {busyId === container.id && busyAction === 'stop' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Square className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="docker-action-button is-restart"
                        disabled={busyId === container.id}
                        title={translate('terminal.docker.restart')}
                        aria-label={translate('terminal.docker.restart')}
                        onClick={() => setPendingAction({ container, action: 'restart' })}
                      >
                        {busyId === container.id && busyAction === 'restart' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button type="button" className="docker-action-button is-logs" title={translate('terminal.docker.logs')} aria-label={translate('terminal.docker.logs')} onClick={() => { void openLogs(container); }}>
                        <ScrollText className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="docker-action-button is-exec"
                        disabled={container.state !== 'running'}
                        title={translate('terminal.docker.exec')}
                        aria-label={translate('terminal.docker.exec')}
                        onClick={() => setExecTarget(container.id)}
                      >
                        <TerminalSquare className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {error && available !== false ? <div className="border-t border-danger-muted bg-danger-muted px-4 py-1.5 text-xs text-danger">{error}</div> : null}
      </div>

      {detail ? (
        <div className="fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4" onClick={() => setDetail(null)}>
          <div className="modal-backdrop" />
          <div className="industrial-modal relative my-auto flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden" onClick={(event) => event.stopPropagation()}>
            <div className="industrial-modal-header shrink-0 text-sm font-semibold text-fg">
              <span>{detail.name}</span>
              <button type="button" className="icon-button" onClick={() => setDetail(null)}><X className="h-4 w-4" /></button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-fg-secondary">
              <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
                <dt className="text-fg-muted">ID</dt><dd className="break-all">{detail.id}</dd>
                <dt className="text-fg-muted">Image</dt><dd>{detail.image}</dd>
                <dt className="text-fg-muted">Command</dt><dd className="break-all">{detail.command}</dd>
                <dt className="text-fg-muted">State</dt><dd>{detail.state} (exit {String(detail.exitCode ?? '-')})</dd>
                <dt className="text-fg-muted">Started</dt><dd>{detail.startedAt}</dd>
                <dt className="text-fg-muted">RestartCount</dt><dd>{detail.restartCount}</dd>
                <dt className="text-fg-muted">Networks</dt><dd>{detail.networks.join(', ') || '-'}</dd>
              </dl>
              {detail.ports.length > 0 ? (
                <div className="mt-3">
                  <div className="mb-1 text-fg-muted">Ports</div>
                  <ul className="space-y-0.5">{detail.ports.map((port) => <li key={`${port.container}-${port.host}`}>{port.container} → {port.host || '-'}</li>)}</ul>
                </div>
              ) : null}
              {detail.mounts.length > 0 ? (
                <div className="mt-3">
                  <div className="mb-1 text-fg-muted">Mounts</div>
                  <ul className="space-y-0.5">{detail.mounts.map((mount) => <li key={`${mount.source}-${mount.destination}`}>{mount.source} → {mount.destination}{mount.readOnly ? ' (ro)' : ''}</li>)}</ul>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {logs ? (
        <div className="fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4" onClick={() => setLogs(null)}>
          <div className="modal-backdrop" />
          <div className="industrial-modal relative my-auto flex h-[70vh] w-full max-w-5xl flex-col overflow-hidden" onClick={(event) => event.stopPropagation()}>
            <div className="industrial-modal-header shrink-0 text-sm font-semibold text-fg">
              <span>{translate('terminal.docker.logsTitle', { container: logs.containerId.slice(0, 12) })}</span>
              <div className="flex items-center gap-2">
                <input
                  className="industrial-input h-7 w-52 text-xs"
                  placeholder={translate('terminal.docker.logsSearchPlaceholder')}
                  value={logSearch}
                  onChange={(event) => setLogSearch(event.target.value)}
                />
                <button
                  type="button"
                  className={`toolbar-button h-7 px-2 text-xs ${follow ? 'text-accent' : 'text-fg-muted'}`}
                  onClick={() => setFollow((value) => !value)}
                  title={follow ? translate('terminal.docker.logsFollowOn') : translate('terminal.docker.logsFollowOff')}
                >
                  {follow ? translate('terminal.docker.logsFollowing') : translate('terminal.docker.logsPaused')}
                </button>
                <button type="button" className="icon-button" onClick={() => setLogs(null)}><X className="h-4 w-4" /></button>
              </div>
            </div>
            <pre ref={logPreRef} onScroll={handleLogScroll} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-surface p-3 font-mono text-[11px] text-fg-secondary">{visibleLogs || translate('terminal.docker.logsEmpty')}</pre>
          </div>
        </div>
      ) : null}

      {execTarget ? (
        <DockerExecTerminal
          connectionId={connectionId}
          containerId={execTarget}
          shell=""
          translate={translate}
          onClose={() => setExecTarget(null)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={pendingAction !== null}
        type="warning"
        title={translate('terminal.docker.confirmTitle', {
          action: pendingAction ? translate(`terminal.docker.${pendingAction.action}`) : '',
        })}
        message={translate('terminal.docker.confirmMessage', {
          action: pendingAction ? translate(`terminal.docker.${pendingAction.action}`) : '',
          name: pendingAction?.container.name || pendingAction?.container.id.slice(0, 12) || '',
        })}
        confirmText={pendingAction ? translate(`terminal.docker.${pendingAction.action}`) : undefined}
        onConfirm={() => {
          const pending = pendingAction;
          setPendingAction(null);
          if (pending) void runAction(pending.container, pending.action);
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>,
    document.body,
  );
}
