import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Container, Play, RotateCcw, ScrollText, Square, TerminalSquare, X } from 'lucide-react';
import type { DockerContainerDetail, DockerContainerSummary } from '../../../shared/ipc-types';
import { DockerExecTerminal } from './DockerExecTerminal';

interface DockerPanelProps {
  connectionId: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

type ActionKind = 'start' | 'stop' | 'restart';

/** 容器管理弹窗：列表 + 详情 + 启停/重启 + 日志 + 进入容器 shell。 */
export function DockerPanel({ connectionId, translate, onClose }: DockerPanelProps) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [version, setVersion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [logs, setLogs] = useState<{ containerId: string; text: string } | null>(null);
  const [logSearch, setLogSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const logPreRef = useRef<HTMLPreElement | null>(null);
  const [execTarget, setExecTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

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
    try {
      const result = await api(connectionId, container.id, action);
      if (!result.success) setError(result.error || `${action} failed`);
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const openDetail = async (container: DockerContainerSummary) => {
    const api = window.electronAPI?.inspectDockerContainer;
    if (!api) return;
    const result = await api(connectionId, container.id);
    if (result.success) setDetail(result.data);
    else setError(result.error || 'inspect failed');
  };

  const openLogs = async (container: DockerContainerSummary) => {
    const api = window.electronAPI?.dockerContainerLogs;
    if (!api) return;
    const result = await api(connectionId, container.id, 500);
    setLogSearch('');
    setFollow(true);
    setLogs({
      containerId: container.id,
      text: result.success ? result.data.logs : (result.error || 'logs failed'),
    });
  };

  // 跟随模式：每 2 秒拉取最新 500 行并贴底；关闭即冻结当前内容。
  useEffect(() => {
    if (!logs || !follow) return undefined;
    const api = window.electronAPI?.dockerContainerLogs;
    if (!api) return undefined;
    const containerId = logs.containerId;
    const timer = window.setInterval(() => {
      void (async () => {
        const result = await api(connectionId, containerId, 500);
        if (result.success) {
          setLogs((current) =>
            current && current.containerId === containerId ? { ...current, text: result.data.logs } : current,
          );
        }
      })();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [logs, follow, connectionId]);

  // 内容更新后（且处于跟随/首次打开）自动滚到最下方，显示最新日志。
  useEffect(() => {
    if (!logs || !follow) return;
    const pre = logPreRef.current;
    if (pre) pre.scrollTop = pre.scrollHeight;
  }, [logs, follow]);

  const visibleLogs = useMemo(() => {
    if (!logs) return '';
    const keyword = logSearch.trim().toLowerCase();
    if (!keyword) return logs.text;
    return logs.text
      .split('\n')
      .filter((line) => line.toLowerCase().includes(keyword))
      .join('\n');
  }, [logs, logSearch]);

  const filtered = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    if (!keyword) return containers;
    return containers.filter((item) =>
      item.name.toLowerCase().includes(keyword)
      || item.image.toLowerCase().includes(keyword)
      || item.state.toLowerCase().includes(keyword));
  }, [containers, filter]);

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="industrial-modal relative my-auto flex h-[84vh] w-full max-w-6xl flex-col overflow-hidden">
        <div className="industrial-modal-header shrink-0">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-fg">
            <Container className="h-4 w-4 text-accent" />
            {translate('terminal.docker.title')}
            {version ? <span className="text-xs font-normal text-fg-muted">v{version}</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <input
              className="industrial-input w-48"
              placeholder={translate('terminal.docker.filterPlaceholder')}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button type="button" className="toolbar-button" onClick={() => { void refresh(); }}>
              {translate('terminal.docker.refresh')}
            </button>
            <button type="button" className="icon-button" onClick={onClose} title={translate('terminal.docker.close')}>
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {available === false ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-fg-muted">
            <span>{error || translate('terminal.docker.unavailable')}</span>
            <span className="text-xs">{translate('terminal.docker.unavailableHint')}</span>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="sticky top-0 bg-surface text-xs uppercase text-fg-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">{translate('terminal.docker.name')}</th>
                  <th className="px-3 py-2 font-medium">{translate('terminal.docker.image')}</th>
                  <th className="px-3 py-2 font-medium">{translate('terminal.docker.state')}</th>
                  <th className="px-3 py-2 font-medium">{translate('terminal.docker.ports')}</th>
                  <th className="px-3 py-2 text-right font-medium">{translate('terminal.docker.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-fg-muted">
                      {available === null ? translate('terminal.docker.loading') : translate('terminal.docker.empty')}
                    </td>
                  </tr>
                ) : filtered.map((container) => (
                  <tr key={container.id} className="border-t border-line hover:bg-surface-hover">
                    <td className="max-w-[16rem] truncate px-3 py-1.5 text-fg" title={container.name}>
                      <button type="button" className="hover:text-accent" onClick={() => { void openDetail(container); }}>
                        {container.name}
                      </button>
                    </td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5 text-fg-secondary" title={container.image}>{container.image}</td>
                    <td className="px-3 py-1.5">
                      <span className={container.state === 'running' ? 'text-success' : 'text-fg-muted'}>{container.status || container.state}</span>
                    </td>
                    <td className="max-w-[16rem] truncate px-3 py-1.5 text-xs text-fg-muted" title={container.ports}>{container.ports}</td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-right">
                      <button
                        type="button"
                        className="terminal-control"
                        disabled={busyId === container.id || container.state === 'running'}
                        title={translate('terminal.docker.start')}
                        onClick={() => { void runAction(container, 'start'); }}
                      >
                        <Play className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="terminal-control"
                        disabled={busyId === container.id || container.state !== 'running'}
                        title={translate('terminal.docker.stop')}
                        onClick={() => { void runAction(container, 'stop'); }}
                      >
                        <Square className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="terminal-control"
                        disabled={busyId === container.id}
                        title={translate('terminal.docker.restart')}
                        onClick={() => { void runAction(container, 'restart'); }}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" className="terminal-control" title={translate('terminal.docker.logs')} onClick={() => { void openLogs(container); }}>
                        <ScrollText className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="terminal-control"
                        disabled={container.state !== 'running'}
                        title={translate('terminal.docker.exec')}
                        onClick={() => setExecTarget(container.id)}
                      >
                        <TerminalSquare className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {error ? <div className="border-t border-danger-muted bg-danger-muted px-4 py-1.5 text-xs text-danger">{error}</div> : null}
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
            <pre ref={logPreRef} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-surface p-3 font-mono text-[11px] text-fg-secondary">{visibleLogs || translate('terminal.docker.logsEmpty')}</pre>
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
    </div>,
    document.body,
  );
}
