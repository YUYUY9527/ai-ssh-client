import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, ArrowDownCircle, Box, ChevronDown, Container, Copy, Database, FileCode2, HardDrive, Info, Layers3, Loader2, MoreHorizontal, Network, Play, Power, RefreshCw, RotateCcw, Save, ScrollText, Search, Square, TerminalSquare, Trash2, X } from 'lucide-react';
import type {
  DockerComposeProject,
  DockerContainerDetail,
  DockerContainerStat,
  DockerContainerSummary,
  DockerImageItem,
  DockerNetworkItem,
  DockerPruneTarget,
  DockerVolumeItem,
} from '../../../shared/ipc-types';
import { DockerExecTerminal } from './DockerExecTerminal';
import { ConfirmDialog } from '../../shared-ui/ConfirmDialog';
import { getWebSftpClientId } from '../../lib/web';
import { useSessionOverlay } from '../../workspace/SessionOverlayContext';
import { detectCodeLanguage } from '../../transfer/code-format';

const CodeEditor = lazy(() => import('../../transfer/CodeEditor').then((module) => ({ default: module.CodeEditor })));

interface DockerPanelProps {
  connectionId: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

type ActionKind = 'start' | 'stop' | 'restart' | 'update' | 'recreate' | 'kill' | 'remove';
type ContainerFilter = 'all' | 'running' | 'stopped';
type DockerTab = 'containers' | 'images' | 'volumes' | 'networks' | 'compose';

interface RowMenuState {
  container: DockerContainerSummary;
  top: number;
  bottom: number;
  right: number;
  openUp: boolean;
}

interface PruneMenuState {
  top: number;
  right: number;
}

const MENU_ACTION_SET = new Set<ActionKind>(['update', 'recreate', 'kill', 'remove']);

async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // 无剪贴板权限时走下面的兜底方案
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** 容器管理弹窗：列表 + 详情 + 启停/重启 + 更多操作菜单 + 清理 + 日志 + 容器 shell。 */
export function DockerPanel({ connectionId, translate, onClose }: DockerPanelProps) {
  const overlay = useSessionOverlay();
  const isSessionScoped = Boolean(overlay.container);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [version, setVersion] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [containers, setContainers] = useState<DockerContainerSummary[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<ActionKind | null>(null);
  const [pruningTarget, setPruningTarget] = useState<DockerPruneTarget | null>(null);
  const [pendingAction, setPendingAction] = useState<{ container: DockerContainerSummary; action: ActionKind } | null>(null);
  const [pendingPrune, setPendingPrune] = useState<DockerPruneTarget | null>(null);
  const [openMenu, setOpenMenu] = useState<RowMenuState | null>(null);
  const [pruneMenu, setPruneMenu] = useState<PruneMenuState | null>(null);
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [detailLoadingName, setDetailLoadingName] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ containerId: string; text: string } | null>(null);
  const [logSearch, setLogSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const logPreRef = useRef<HTMLPreElement | null>(null);
  const rowMenuRef = useRef<HTMLDivElement | null>(null);
  const pruneMenuRef = useRef<HTMLDivElement | null>(null);
  const pruneTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [execTarget, setExecTarget] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [containerFilter, setContainerFilter] = useState<ContainerFilter>('all');
  const [activeTab, setActiveTab] = useState<DockerTab>('containers');
  const [statsById, setStatsById] = useState<Record<string, DockerContainerStat>>({});
  const [images, setImages] = useState<DockerImageItem[]>([]);
  const [volumes, setVolumes] = useState<DockerVolumeItem[]>([]);
  const [networks, setNetworks] = useState<DockerNetworkItem[]>([]);
  const [composeProjects, setComposeProjects] = useState<DockerComposeProject[]>([]);
  const [composeEditor, setComposeEditor] = useState<{
    project: string;
    path: string;
    content: string;
    originalContent: string;
    savingMode: null | 'save' | 'apply';
  } | null>(null);
  const [resourceLoading, setResourceLoading] = useState(false);

  const loadResourceTab = useCallback(async (tab: DockerTab) => {
    if (tab === 'containers') {
      if (window.electronAPI?.getDockerStats) {
        const res = await window.electronAPI.getDockerStats(connectionId);
        if (res.success) {
          const next: Record<string, DockerContainerStat> = {};
          for (const stat of res.data.stats || []) {
            if (stat.id) next[stat.id.slice(0, 12)] = stat;
            if (stat.name) next[stat.name] = stat;
          }
          setStatsById(next);
        }
      }
      return;
    }
    setResourceLoading(true);
    try {
      if (tab === 'images' && window.electronAPI?.listDockerImages) {
        const res = await window.electronAPI.listDockerImages(connectionId);
        if (res.success) setImages(res.data.images || []);
        else setError(res.error);
      } else if (tab === 'volumes' && window.electronAPI?.listDockerVolumes) {
        const res = await window.electronAPI.listDockerVolumes(connectionId);
        if (res.success) setVolumes(res.data.volumes || []);
        else setError(res.error);
      } else if (tab === 'networks' && window.electronAPI?.listDockerNetworks) {
        const res = await window.electronAPI.listDockerNetworks(connectionId);
        if (res.success) setNetworks(res.data.networks || []);
        else setError(res.error);
      } else if (tab === 'compose' && window.electronAPI?.listDockerComposeProjects) {
        const res = await window.electronAPI.listDockerComposeProjects(connectionId);
        if (res.success) setComposeProjects(res.data.projects || []);
        else setError(res.error);
      }
    } finally {
      setResourceLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (!overlay.isActive || available !== true) return;
    void loadResourceTab(activeTab);
  }, [activeTab, available, overlay.isActive, loadResourceTab]);

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

  // 仅当前会话处于激活可见态时轮询容器状态；切回本会话时自动补刷一次
  useEffect(() => {
    if (!overlay.isActive) {
      setOpenMenu(null);
      setPruneMenu(null);
      return undefined;
    }
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh, overlay.isActive]);

  // 点击外部或窗口尺寸变化时关闭浮动菜单
  useEffect(() => {
    if (!openMenu && !pruneMenu) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (rowMenuRef.current?.contains(target)) return;
      if (pruneMenuRef.current?.contains(target)) return;
      if (pruneTriggerRef.current?.contains(target)) return;
      if (target.closest('[data-docker-more-trigger]')) return;
      setOpenMenu(null);
      setPruneMenu(null);
    };
    const handleResize = () => {
      setOpenMenu(null);
      setPruneMenu(null);
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('resize', handleResize);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [openMenu, pruneMenu]);

  // 激活会话下按 Esc 逐层关闭（容器终端内不拦截 Esc 以免影响 vim；确认框或全局弹层打开时让位）
  useEffect(() => {
    if (!overlay.isActive || pendingAction !== null || pendingPrune !== null || execTarget !== null) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('[role="dialog"][data-modal-scope="global"]')) return;
      if (openMenu || pruneMenu) {
        event.stopPropagation();
        setOpenMenu(null);
        setPruneMenu(null);
      } else if (logs) {
        event.stopPropagation();
        setLogs(null);
      } else if (detail) {
        event.stopPropagation();
        setDetail(null);
      } else {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [overlay.isActive, pendingAction, pendingPrune, execTarget, openMenu, pruneMenu, logs, detail, onClose]);

  const runAction = async (container: DockerContainerSummary, action: ActionKind) => {
    setError(null);
    setNotice(null);
    setBusyId(container.id);
    setBusyAction(action);
    try {
      if (action === 'update') {
        const api = window.electronAPI?.updateDockerContainer;
        if (!api) {
          setError(translate('terminal.docker.updateUnavailable'));
          return;
        }
        const result = await api(connectionId, container.id);
        if (!result.success) {
          setError(result.error || translate('terminal.docker.updateFailed'));
        } else if (result.data) {
          setNotice(
            result.data.mode === 'compose'
              ? translate('terminal.docker.updateDoneCompose', {
                project: result.data.project,
                service: result.data.service,
              })
              : translate('terminal.docker.updateDonePull'),
          );
        }
        await refresh();
        return;
      }
      if (action === 'recreate') {
        const api = window.electronAPI?.recreateDockerContainer;
        if (!api) {
          setError(translate('terminal.docker.recreateUnavailable'));
          return;
        }
        const result = await api(connectionId, container.id);
        if (!result.success) {
          setError(result.error || translate('terminal.docker.recreateFailed'));
        } else if (result.data) {
          setNotice(translate('terminal.docker.recreateDone', {
            project: result.data.project,
            service: result.data.service,
          }));
        }
        await refresh();
        return;
      }
      if (action === 'remove') {
        const api = window.electronAPI?.removeDockerContainer;
        if (!api) {
          setError(translate('terminal.docker.removeUnavailable'));
          return;
        }
        const force = container.state === 'running' || container.state === 'paused';
        const result = await api(connectionId, container.id, force);
        if (!result.success) {
          setError(result.error || translate('terminal.docker.removeFailed'));
        } else {
          setNotice(translate('terminal.docker.removeDone', {
            name: container.name || container.id.slice(0, 12),
          }));
          if (detail?.id === container.id) setDetail(null);
          if (logs?.containerId === container.id) setLogs(null);
        }
        await refresh();
        return;
      }
      const api = window.electronAPI?.dockerContainerAction;
      if (!api) return;
      const result = await api(connectionId, container.id, action);
      if (!result.success) setError(result.error || `${action} failed`);
      await refresh();
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const runPrune = async (target: DockerPruneTarget) => {
    const api = window.electronAPI?.pruneDocker;
    if (!api) {
      setError(translate('terminal.docker.pruneUnavailable'));
      return;
    }
    setError(null);
    setNotice(null);
    setPruningTarget(target);
    try {
      const result = await api(connectionId, target);
      if (!result.success) {
        setError(result.error || translate('terminal.docker.pruneFailed'));
      } else {
        const targetLabel = target === 'containers'
          ? translate('terminal.docker.pruneContainers')
          : translate('terminal.docker.pruneImages');
        setNotice(
          result.data.reclaimedSpace
            ? translate('terminal.docker.pruneDoneSpace', {
              target: targetLabel,
              space: result.data.reclaimedSpace,
            })
            : translate('terminal.docker.pruneDone', { target: targetLabel }),
        );
      }
      await refresh();
    } finally {
      setPruningTarget(null);
    }
  };

  const openDetail = async (container: DockerContainerSummary) => {
    const api = window.electronAPI?.inspectDockerContainer;
    if (!api) return;
    setDetail(null);
    setDetailLoadingName(container.name);
    try {
      const result = await api(connectionId, container.id);
      if (result.success) setDetail(result.data);
      else setError(result.error || 'inspect failed');
    } finally {
      setDetailLoadingName(null);
    }
  };

  const openLogs = (container: DockerContainerSummary) => {
    setLogSearch('');
    setFollow(true);
    setLogs({ containerId: container.id, text: '' });
  };

  const toggleRowMenu = (container: DockerContainerSummary, trigger: HTMLButtonElement) => {
    setPruneMenu(null);
    if (openMenu?.container.id === container.id) {
      setOpenMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = 336;
    const right = Math.max(8, window.innerWidth - rect.right);
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < estimatedHeight && rect.top > spaceBelow;
    setOpenMenu({
      container,
      top: Math.max(8, rect.bottom + 6),
      bottom: Math.max(8, window.innerHeight - rect.top + 6),
      right,
      openUp,
    });
  };

  const togglePruneMenu = (trigger: HTMLButtonElement) => {
    setOpenMenu(null);
    if (pruneMenu) {
      setPruneMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - rect.right);
    const top = Math.min(rect.bottom + 6, Math.max(8, window.innerHeight - 120));
    setPruneMenu({ top, right });
  };

  const handleCopy = async (value: string, labelKey: string) => {
    setOpenMenu(null);
    const ok = await copyText(value);
    if (ok) {
      setError(null);
      setNotice(translate('terminal.docker.copied', {
        label: translate(labelKey),
        value,
      }));
    } else {
      setError(translate('terminal.docker.copyFailed'));
    }
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

  const confirmDialogConfig = useMemo(() => {
    if (pendingPrune) {
      const targetLabel = pendingPrune === 'containers'
        ? translate('terminal.docker.pruneContainers')
        : translate('terminal.docker.pruneImages');
      return {
        isOpen: true,
        title: translate('terminal.docker.pruneConfirmTitle', { target: targetLabel }),
        message: pendingPrune === 'containers'
          ? translate('terminal.docker.pruneContainersConfirmMessage')
          : translate('terminal.docker.pruneImagesConfirmMessage'),
        confirmText: targetLabel,
        onConfirm: () => {
          const target = pendingPrune;
          setPendingPrune(null);
          void runPrune(target);
        },
        onCancel: () => setPendingPrune(null),
      };
    }
    if (!pendingAction) {
      return {
        isOpen: false,
        title: '',
        message: '',
        confirmText: undefined,
        onConfirm: () => undefined,
        onCancel: () => undefined,
      };
    }
    const { container, action } = pendingAction;
    const containerName = container.name || container.id.slice(0, 12);
    const actionLabel = translate(`terminal.docker.${action}`);
    let message = translate('terminal.docker.confirmMessage', {
      action: actionLabel,
      name: containerName,
    });
    if (action === 'update') {
      message = translate('terminal.docker.updateConfirmMessage', { name: containerName });
    } else if (action === 'recreate') {
      message = translate('terminal.docker.recreateConfirmMessage', {
        service: container.composeService || containerName,
        name: containerName,
      });
    } else if (action === 'kill') {
      message = translate('terminal.docker.killConfirmMessage', { name: containerName });
    } else if (action === 'remove') {
      const isActive = container.state === 'running' || container.state === 'paused';
      message = translate(
        isActive ? 'terminal.docker.removeForceConfirmMessage' : 'terminal.docker.removeConfirmMessage',
        { name: containerName },
      );
    }
    return {
      isOpen: true,
      title: translate('terminal.docker.confirmTitle', { action: actionLabel }),
      message,
      confirmText: actionLabel,
      onConfirm: () => {
        const pending = pendingAction;
        setPendingAction(null);
        if (pending) void runAction(pending.container, pending.action);
      },
      onCancel: () => setPendingAction(null),
    };
  }, [pendingPrune, pendingAction, translate]);

  const portalTarget = overlay.container ?? document.body;
  const layerClass = isSessionScoped
    ? 'pointer-events-auto absolute inset-0 z-overlay flex items-center justify-center overflow-y-auto p-4'
    : 'fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4';
  const mainPanelHeightClass = isSessionScoped ? 'h-[min(94%,860px)] max-h-full' : 'h-[88vh]';
  const detailPanelHeightClass = isSessionScoped ? 'max-h-[90%]' : 'max-h-[80vh]';
  const logsPanelHeightClass = isSessionScoped ? 'h-[min(86%,740px)] max-h-full' : 'h-[70vh]';

  return createPortal(
    <div className={layerClass}>
      <div className="modal-backdrop" onClick={onClose} />
      <div className={`industrial-modal relative my-auto flex ${mainPanelHeightClass} w-full max-w-6xl flex-col overflow-hidden`}>
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
            <button
              ref={pruneTriggerRef}
              type="button"
              className={`docker-prune-trigger ${pruneMenu ? 'is-open' : ''}`}
              disabled={available !== true || pruningTarget !== null}
              aria-haspopup="menu"
              aria-expanded={pruneMenu !== null}
              onClick={(event) => togglePruneMenu(event.currentTarget)}
              title={translate('terminal.docker.prune')}
            >
              {pruningTarget !== null ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              <span>{translate('terminal.docker.prune')}</span>
              <ChevronDown className="h-3.5 w-3.5 text-fg-muted" />
            </button>
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
          <div
            className={`min-h-0 flex-1 ${activeTab === 'compose' && composeEditor ? 'flex flex-col overflow-hidden' : 'overflow-auto'}`}
            onScroll={() => {
              if (openMenu) setOpenMenu(null);
            }}
          >
            <div className={`docker-panel-content ${activeTab === 'compose' && composeEditor ? 'flex min-h-0 flex-1 flex-col' : ''}`}>
              <div className="mb-3 flex shrink-0 flex-wrap items-center gap-1 border-b border-line-subtle pb-2">
                {([
                  { id: 'containers', label: translate('terminal.docker.tabs.containers'), icon: Container },
                  { id: 'images', label: translate('terminal.docker.tabs.images'), icon: HardDrive },
                  { id: 'volumes', label: translate('terminal.docker.tabs.volumes'), icon: Database },
                  { id: 'networks', label: translate('terminal.docker.tabs.networks'), icon: Network },
                  { id: 'compose', label: translate('terminal.docker.tabs.compose'), icon: FileCode2 },
                ] as const).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTab(tab.id)}
                    className={`inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${
                      activeTab === tab.id
                        ? 'bg-accent-muted text-accent'
                        : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
                    }`}
                  >
                    <tab.icon className="h-3.5 w-3.5" />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>

              {activeTab === 'images' && (
                <div className="space-y-2">
                  {resourceLoading ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('common.loading')}</div>
                  ) : images.length === 0 ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('terminal.docker.empty')}</div>
                  ) : images.map((img) => (
                    <div key={`${img.id}-${img.repository}-${img.tag}`} className="flex items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono font-medium text-fg">{img.repository}:{img.tag}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-fg-muted">{img.id} · {img.size} · {img.createdSince}</div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.electronAPI?.removeDockerImage) return;
                          const res = await window.electronAPI.removeDockerImage(connectionId, img.id, false);
                          if (!res.success) setError(res.error);
                          else await loadResourceTab('images');
                        }}
                        className="icon-button h-7 w-7 text-danger"
                        title={translate('common.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'volumes' && (
                <div className="space-y-2">
                  {resourceLoading ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('common.loading')}</div>
                  ) : volumes.length === 0 ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('terminal.docker.empty')}</div>
                  ) : volumes.map((vol) => (
                    <div key={vol.name} className="flex items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono font-medium text-fg">{vol.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-muted">{vol.driver}{vol.mountpoint ? ` · ${vol.mountpoint}` : ''}</div>
                      </div>
                      <button
                        type="button"
                        onClick={async () => {
                          if (!window.electronAPI?.removeDockerVolume) return;
                          const res = await window.electronAPI.removeDockerVolume(connectionId, vol.name);
                          if (!res.success) setError(res.error);
                          else await loadResourceTab('volumes');
                        }}
                        className="icon-button h-7 w-7 text-danger"
                        title={translate('common.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'networks' && (
                <div className="space-y-2">
                  {resourceLoading ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('common.loading')}</div>
                  ) : networks.length === 0 ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('terminal.docker.empty')}</div>
                  ) : networks.map((net) => (
                    <div key={net.id} className="flex items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono font-medium text-fg">{net.name}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-fg-muted">{net.id} · {net.driver} · {net.scope}</div>
                      </div>
                      {!['bridge', 'host', 'none'].includes(net.name) && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!window.electronAPI?.removeDockerNetwork) return;
                            const res = await window.electronAPI.removeDockerNetwork(connectionId, net.id);
                            if (!res.success) setError(res.error);
                            else await loadResourceTab('networks');
                          }}
                          className="icon-button h-7 w-7 text-danger"
                          title={translate('common.delete')}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'compose' && (
                <div className={composeEditor ? 'flex min-h-0 flex-1 flex-col' : 'space-y-3'}>
                  {composeEditor ? (
                    <div
                      className="flex min-h-0 flex-1 flex-col gap-2.5 rounded-md border border-line bg-surface p-3"
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                          event.preventDefault();
                          if (composeEditor.savingMode || !window.electronAPI?.saveDockerComposeFile) return;
                          const snap = composeEditor;
                          setComposeEditor((prev) => (prev ? { ...prev, savingMode: 'save' } : null));
                          void window.electronAPI
                            .saveDockerComposeFile(connectionId, snap.path, snap.content, snap.project, { apply: false })
                            .then((res) => {
                              if (!res.success) {
                                setError(res.error);
                              } else {
                                setError(null);
                                setNotice(translate('terminal.docker.composeSaved'));
                                setComposeEditor((prev) => (prev ? { ...prev, originalContent: snap.content } : null));
                              }
                            })
                            .finally(() => {
                              setComposeEditor((prev) => (prev ? { ...prev, savingMode: null } : null));
                            });
                        }
                      }}
                    >
                      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-fg">
                            <span>{composeEditor.project}</span>
                            {composeEditor.content !== composeEditor.originalContent && (
                              <span className="h-1.5 w-1.5 rounded-full bg-warning" title="*" />
                            )}
                          </div>
                          <div className="truncate font-mono text-[11px] text-fg-muted">{composeEditor.path}</div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={composeEditor.savingMode !== null}
                            onClick={() => setComposeEditor(null)}
                            className="industrial-button-secondary px-2.5 py-1 text-xs"
                          >
                            {translate('common.cancel')}
                          </button>
                          <button
                            type="button"
                            disabled={composeEditor.savingMode !== null}
                            onClick={async () => {
                              if (!window.electronAPI?.saveDockerComposeFile) return;
                              const snap = composeEditor;
                              setComposeEditor((prev) => (prev ? { ...prev, savingMode: 'save' } : null));
                              try {
                                const res = await window.electronAPI.saveDockerComposeFile(
                                  connectionId,
                                  snap.path,
                                  snap.content,
                                  snap.project,
                                  { apply: false },
                                );
                                if (!res.success) {
                                  setError(res.error);
                                } else {
                                  setError(null);
                                  setNotice(translate('terminal.docker.composeSaved'));
                                  setComposeEditor((prev) => (prev ? { ...prev, originalContent: snap.content } : null));
                                }
                              } finally {
                                setComposeEditor((prev) => (prev ? { ...prev, savingMode: null } : null));
                              }
                            }}
                            className="industrial-button-secondary px-2.5 py-1 text-xs"
                          >
                            {composeEditor.savingMode === 'save' ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Save className="h-3.5 w-3.5" />
                            )}
                            {translate('terminal.docker.composeSaveOnly')}
                          </button>
                          <button
                            type="button"
                            disabled={composeEditor.savingMode !== null}
                            onClick={async () => {
                              if (!window.electronAPI?.saveDockerComposeFile) return;
                              const snap = composeEditor;
                              setComposeEditor((prev) => (prev ? { ...prev, savingMode: 'apply' } : null));
                              try {
                                const res = await window.electronAPI.saveDockerComposeFile(
                                  connectionId,
                                  snap.path,
                                  snap.content,
                                  snap.project,
                                  { apply: true },
                                );
                                if (!res.success) {
                                  setError(res.error);
                                } else {
                                  setError(null);
                                  setNotice(translate('terminal.docker.composeApplied'));
                                  setComposeEditor(null);
                                  await refresh();
                                  await loadResourceTab('compose');
                                }
                              } finally {
                                setComposeEditor((prev) => (prev ? { ...prev, savingMode: null } : null));
                              }
                            }}
                            className="industrial-button-primary px-2.5 py-1 text-xs"
                          >
                            {composeEditor.savingMode === 'apply' ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                            {translate('terminal.docker.composeSaveAndUp')}
                          </button>
                        </div>
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-line-subtle bg-app">
                        <Suspense
                          fallback={(
                            <div className="flex h-full items-center justify-center gap-2 text-xs text-fg-muted">
                              <Loader2 className="h-4 w-4 animate-spin text-accent" />
                              <span>{translate('common.loading')}</span>
                            </div>
                          )}
                        >
                          <CodeEditor
                            key={composeEditor.path}
                            value={composeEditor.content}
                            language={detectCodeLanguage(composeEditor.path) === 'text' ? 'yaml' : detectCodeLanguage(composeEditor.path)}
                            readOnly={composeEditor.savingMode !== null}
                            onChange={(nextValue) => setComposeEditor((prev) => (prev ? { ...prev, content: nextValue } : null))}
                          />
                        </Suspense>
                      </div>
                    </div>
                  ) : resourceLoading ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('common.loading')}</div>
                  ) : composeProjects.length === 0 ? (
                    <div className="py-8 text-center text-xs text-fg-muted">{translate('terminal.docker.empty')}</div>
                  ) : composeProjects.map((proj) => (
                    <div key={proj.name} className="flex items-center justify-between gap-3 rounded-md border border-line-subtle bg-surface px-3 py-2 text-xs">
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold text-fg">{proj.name}</div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-fg-muted">{proj.status} · {proj.configFiles}</div>
                      </div>
                      {proj.configFiles && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!window.electronAPI?.readDockerComposeFile) return;
                            const res = await window.electronAPI.readDockerComposeFile(connectionId, proj.configFiles);
                            if (!res.success) {
                              setError(res.error);
                            } else {
                              setComposeEditor({
                                project: proj.name,
                                path: res.data.path,
                                content: res.data.content,
                                originalContent: res.data.content,
                                savingMode: null,
                              });
                            }
                          }}
                          className="industrial-button-secondary px-2.5 py-1 text-xs"
                        >
                          <FileCode2 className="h-3.5 w-3.5" />
                          {translate('terminal.docker.editCompose')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'containers' && (
              <>
              <div className="docker-overview mb-3">
                <button type="button" aria-pressed={containerFilter === 'all'} className={`docker-stat-tile ${containerFilter === 'all' ? 'is-active' : ''}`} onClick={() => setContainerFilter('all')}>
                  <span className="docker-stat-icon"><Layers3 className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0"><span className="docker-stat-label">{translate('terminal.docker.total')}</span><span className="docker-stat-value tabular-nums">{available === null ? '—' : containers.length}</span></span>
                </button>
                <button type="button" aria-pressed={containerFilter === 'running'} className={`docker-stat-tile is-running ${containerFilter === 'running' ? 'is-active' : ''}`} onClick={() => setContainerFilter('running')}>
                  <span className="docker-stat-icon"><Activity className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0"><span className="docker-stat-label">{translate('terminal.docker.running')}</span><span className="docker-stat-value tabular-nums">{available === null ? '—' : runningCount}</span></span>
                </button>
                <button type="button" aria-pressed={containerFilter === 'stopped'} className={`docker-stat-tile is-stopped ${containerFilter === 'stopped' ? 'is-active' : ''}`} onClick={() => setContainerFilter('stopped')}>
                  <span className="docker-stat-icon"><Box className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0"><span className="docker-stat-label">{translate('terminal.docker.stopped')}</span><span className="docker-stat-value tabular-nums">{available === null ? '—' : stoppedCount}</span></span>
                </button>
                <div className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-muted">
                  <span className="docker-live-dot" />{translate('terminal.docker.liveStatus')}
                </div>
              </div>

              <div className="docker-container-list">
                <div className="docker-container-labels">
                  <span>{translate('terminal.docker.name')}</span>
                  <span>{translate('terminal.docker.image')}</span>
                  <span>{translate('terminal.docker.ports')}</span>
                  <span>{translate('terminal.docker.state')}</span>
                  <span className="text-center">{translate('terminal.docker.actions')}</span>
                </div>
                {filtered.length === 0 ? (
                  <div className="docker-empty-state">
                    {available === null ? (
                      <><Loader2 className="h-5 w-5 animate-spin text-accent" /><span>{translate('terminal.docker.loading')}</span></>
                    ) : (
                      <><Box className="h-5 w-5" /><span>{filter || containerFilter !== 'all' ? translate('terminal.docker.noMatches') : translate('terminal.docker.empty')}</span></>
                    )}
                  </div>
                ) : filtered.map((container) => {
                  const isRowBusy = busyId === container.id;
                  const isMenuBusy = isRowBusy && busyAction !== null && MENU_ACTION_SET.has(busyAction);
                  const isMenuOpen = openMenu?.container.id === container.id;
                  return (
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
                      <div className="docker-image-cell" title={container.image}>
                        <span className="docker-mobile-label">{translate('terminal.docker.image')}</span>
                        <span className="min-w-0 truncate">{container.image}</span>
                      </div>
                      <div className="docker-ports-cell" title={container.ports || translate('terminal.docker.noPorts')}>
                        <span className="docker-mobile-label">{translate('terminal.docker.ports')}</span>
                        <span className={`min-w-0 truncate ${container.ports ? '' : 'text-fg-subtle'}`}>{container.ports || translate('terminal.docker.noPorts')}</span>
                      </div>
                      <div className="docker-status-cell">
                        <span className={`docker-status ${container.state === 'running' ? 'is-running' : 'is-stopped'}`}>
                          <span className="docker-status-dot" />{container.state}
                        </span>
                        <span className="docker-runtime">{container.runningFor || container.status}</span>
                        {(() => {
                          const stat = statsById[container.id.slice(0, 12)] || statsById[container.name];
                          return stat ? (
                            <span className="font-mono text-[10px] text-accent tabular-nums">
                              CPU {stat.cpuPerc} · MEM {stat.memPerc}
                            </span>
                          ) : null;
                        })()}
                      </div>
                      <div className="docker-actions">
                        <button
                          type="button"
                          className="docker-action-button is-start"
                          disabled={isRowBusy || container.state === 'running'}
                          title={translate('terminal.docker.start')}
                          aria-label={translate('terminal.docker.start')}
                          onClick={() => setPendingAction({ container, action: 'start' })}
                        >
                          {isRowBusy && busyAction === 'start' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Play className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="docker-action-button is-stop"
                          disabled={isRowBusy || container.state !== 'running'}
                          title={translate('terminal.docker.stop')}
                          aria-label={translate('terminal.docker.stop')}
                          onClick={() => setPendingAction({ container, action: 'stop' })}
                        >
                          {isRowBusy && busyAction === 'stop' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          className="docker-action-button is-restart"
                          disabled={isRowBusy}
                          title={translate('terminal.docker.restart')}
                          aria-label={translate('terminal.docker.restart')}
                          onClick={() => setPendingAction({ container, action: 'restart' })}
                        >
                          {isRowBusy && busyAction === 'restart' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          data-docker-more-trigger={container.id}
                          className={`docker-action-button is-more ${isMenuOpen ? 'is-open' : ''}`}
                          disabled={isRowBusy}
                          title={translate('terminal.docker.more')}
                          aria-label={translate('terminal.docker.more')}
                          aria-haspopup="menu"
                          aria-expanded={isMenuOpen}
                          onClick={(event) => toggleRowMenu(container, event.currentTarget)}
                        >
                          {isMenuBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              </>
              )}
            </div>
          </div>
        )}

        {notice && available !== false ? <div className="border-t border-accent-muted bg-accent-muted px-4 py-1.5 text-xs text-accent dark:text-accent-hover">{notice}</div> : null}
        {error && available !== false ? <div className="border-t border-danger-muted bg-danger-muted px-4 py-1.5 text-xs text-danger">{error}</div> : null}
      </div>

      {openMenu && typeof document !== 'undefined' ? createPortal(
        <div
          ref={rowMenuRef}
          role="menu"
          className="docker-dropdown-menu scrollbar-thin fixed z-tooltip"
          style={
            openMenu.openUp
              ? { bottom: `${openMenu.bottom}px`, right: `${openMenu.right}px` }
              : { top: `${openMenu.top}px`, right: `${openMenu.right}px` }
          }
        >
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item"
            onClick={() => {
              const target = openMenu.container;
              setOpenMenu(null);
              void openLogs(target);
            }}
          >
            <ScrollText className="h-3.5 w-3.5 shrink-0 text-info" />
            <span>{translate('terminal.docker.logs')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item"
            disabled={openMenu.container.state !== 'running'}
            onClick={() => {
              const targetId = openMenu.container.id;
              setOpenMenu(null);
              setExecTarget(targetId);
            }}
          >
            <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span>{translate('terminal.docker.exec')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item"
            onClick={() => {
              const target = openMenu.container;
              setOpenMenu(null);
              void openDetail(target);
            }}
          >
            <Info className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
            <span>{translate('terminal.docker.inspect')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item"
            onClick={() => { void handleCopy(openMenu.container.name, 'terminal.docker.name'); }}
          >
            <Copy className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
            <span>{translate('terminal.docker.copyName')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item"
            onClick={() => { void handleCopy(openMenu.container.id.slice(0, 12), 'terminal.docker.shortId'); }}
          >
            <Copy className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
            <span>{translate('terminal.docker.copyId')}</span>
          </button>

          <div className="docker-dropdown-divider" />

          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item"
            disabled={busyId === openMenu.container.id || !openMenu.container.composeService}
            title={openMenu.container.composeService
              ? translate('terminal.docker.recreate')
              : translate('terminal.docker.recreateComposeOnly')}
            onClick={() => {
              const target = openMenu.container;
              setOpenMenu(null);
              setPendingAction({ container: target, action: 'recreate' });
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span>{translate('terminal.docker.recreate')}</span>
            {!openMenu.container.composeService ? (
              <span className="docker-dropdown-hint">{translate('terminal.docker.composeOnlyTag')}</span>
            ) : null}
          </button>
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item"
            disabled={busyId === openMenu.container.id}
            title={openMenu.container.composeService
              ? translate('terminal.docker.update')
              : translate('terminal.docker.updatePullOnly')}
            onClick={() => {
              const target = openMenu.container;
              setOpenMenu(null);
              setPendingAction({ container: target, action: 'update' });
            }}
          >
            <ArrowDownCircle className="h-3.5 w-3.5 shrink-0 text-accent" />
            <span>{translate('terminal.docker.update')}</span>
          </button>

          <div className="docker-dropdown-divider" />

          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item is-danger"
            disabled={busyId === openMenu.container.id || (openMenu.container.state !== 'running' && openMenu.container.state !== 'paused')}
            onClick={() => {
              const target = openMenu.container;
              setOpenMenu(null);
              setPendingAction({ container: target, action: 'kill' });
            }}
          >
            <Power className="h-3.5 w-3.5 shrink-0" />
            <span>{translate('terminal.docker.kill')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item is-danger"
            disabled={busyId === openMenu.container.id}
            onClick={() => {
              const target = openMenu.container;
              setOpenMenu(null);
              setPendingAction({ container: target, action: 'remove' });
            }}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>{translate('terminal.docker.remove')}</span>
          </button>
        </div>,
        document.body,
      ) : null}

      {pruneMenu && typeof document !== 'undefined' ? createPortal(
        <div
          ref={pruneMenuRef}
          role="menu"
          className="docker-dropdown-menu scrollbar-thin fixed z-tooltip"
          style={{ top: `${pruneMenu.top}px`, right: `${pruneMenu.right}px` }}
        >
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item is-danger"
            onClick={() => {
              setPruneMenu(null);
              setPendingPrune('containers');
            }}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>{translate('terminal.docker.pruneContainers')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="docker-dropdown-item is-danger"
            onClick={() => {
              setPruneMenu(null);
              setPendingPrune('images');
            }}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" />
            <span>{translate('terminal.docker.pruneImages')}</span>
          </button>
        </div>,
        document.body,
      ) : null}

      {(detail || detailLoadingName) ? (
        <div className={layerClass} onClick={() => { setDetail(null); setDetailLoadingName(null); }}>
          <div className="modal-backdrop" />
          <div className={`industrial-modal relative my-auto flex ${detailPanelHeightClass} w-full max-w-3xl flex-col overflow-hidden`} onClick={(event) => event.stopPropagation()}>
            <div className="industrial-modal-header shrink-0 text-sm font-semibold text-fg">
              <span className="min-w-0 flex-1 truncate" title={detail?.name || detailLoadingName || ''}>
                {detail?.name || detailLoadingName}
              </span>
              <button
                type="button"
                className="icon-button shrink-0"
                onClick={() => { setDetail(null); setDetailLoadingName(null); }}
                title={translate('common.close')}
                aria-label={translate('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-auto p-4 text-xs text-fg-secondary">
              {!detail ? (
                <div className="flex items-center justify-center gap-2 py-12 text-fg-muted">
                  <Loader2 className="h-4 w-4 animate-spin text-accent" />
                  <span>{translate('terminal.docker.loading')}</span>
                </div>
              ) : (
                <>
                  <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5">
                    <dt className="text-fg-muted">{translate('terminal.docker.shortId')}</dt>
                    <dd className="min-w-0 break-all font-mono">{detail.id}</dd>
                    <dt className="text-fg-muted">{translate('terminal.docker.image')}</dt>
                    <dd className="min-w-0 break-all font-mono">{detail.image}</dd>
                    <dt className="text-fg-muted">{translate('terminal.docker.detailCommand')}</dt>
                    <dd className="min-w-0 break-all font-mono">{detail.command}</dd>
                    <dt className="text-fg-muted">{translate('terminal.docker.state')}</dt>
                    <dd className="min-w-0 break-words">{detail.state} (exit {String(detail.exitCode ?? '-')})</dd>
                    <dt className="text-fg-muted">{translate('terminal.docker.detailStarted')}</dt>
                    <dd className="min-w-0 break-words font-mono">{detail.startedAt}</dd>
                    <dt className="text-fg-muted">{translate('terminal.docker.detailRestartCount')}</dt>
                    <dd className="min-w-0 font-mono tabular-nums">{detail.restartCount}</dd>
                    <dt className="text-fg-muted">{translate('terminal.docker.detailNetworks')}</dt>
                    <dd className="min-w-0 break-all">{detail.networks.join(', ') || '-'}</dd>
                  </dl>
                  {detail.ports.length > 0 ? (
                    <div className="mt-3.5 border-t border-line-subtle pt-3">
                      <div className="mb-1.5 font-medium text-fg-muted">{translate('terminal.docker.ports')}</div>
                      <ul className="space-y-1 font-mono">{detail.ports.map((port) => <li key={`${port.container}-${port.host}`} className="break-all">{port.container} → {port.host || '-'}</li>)}</ul>
                    </div>
                  ) : null}
                  {detail.mounts.length > 0 ? (
                    <div className="mt-3.5 border-t border-line-subtle pt-3">
                      <div className="mb-1.5 font-medium text-fg-muted">{translate('terminal.docker.detailMounts')}</div>
                      <ul className="space-y-1 font-mono">{detail.mounts.map((mount) => <li key={`${mount.source}-${mount.destination}`} className="break-all">{mount.source} → {mount.destination}{mount.readOnly ? ' (ro)' : ''}</li>)}</ul>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {logs ? (
        <div className={layerClass} onClick={() => setLogs(null)}>
          <div className="modal-backdrop" />
          <div className={`industrial-modal relative my-auto flex ${logsPanelHeightClass} w-full max-w-5xl flex-col overflow-hidden`} onClick={(event) => event.stopPropagation()}>
            <div className="industrial-modal-header shrink-0 flex-wrap gap-2 text-sm font-semibold text-fg">
              <span className="min-w-0 flex-1 truncate" title={translate('terminal.docker.logsTitle', { container: logs.containerId.slice(0, 12) })}>
                {translate('terminal.docker.logsTitle', { container: logs.containerId.slice(0, 12) })}
              </span>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <div className="relative flex items-center">
                  <input
                    className="industrial-input h-7 w-44 py-1 pr-7 text-xs sm:w-52"
                    placeholder={translate('terminal.docker.logsSearchPlaceholder')}
                    aria-label={translate('terminal.docker.logsSearchPlaceholder')}
                    value={logSearch}
                    onChange={(event) => setLogSearch(event.target.value)}
                  />
                  {logSearch && (
                    <button
                      type="button"
                      onClick={() => setLogSearch('')}
                      className="icon-button absolute right-1 h-5 w-5"
                      title={translate('terminal.docker.clearSearch')}
                      aria-label={translate('terminal.docker.clearSearch')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className={`toolbar-button h-7 shrink-0 px-2 text-xs ${follow ? 'text-accent' : 'text-fg-muted'}`}
                  onClick={() => setFollow((value) => !value)}
                  title={follow ? translate('terminal.docker.logsFollowOn') : translate('terminal.docker.logsFollowOff')}
                >
                  {follow ? translate('terminal.docker.logsFollowing') : translate('terminal.docker.logsPaused')}
                </button>
                <button
                  type="button"
                  className="icon-button shrink-0"
                  onClick={() => setLogs(null)}
                  title={translate('common.close')}
                  aria-label={translate('common.close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <pre ref={logPreRef} onScroll={handleLogScroll} className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-primary)] p-3 font-mono text-[11px] leading-5 text-fg-secondary">{visibleLogs || translate('terminal.docker.logsEmpty')}</pre>
          </div>
        </div>
      ) : null}

      {execTarget ? (
        <DockerExecTerminal
          connectionId={connectionId}
          containerId={execTarget}
          shell=""
          translate={translate}
          scoped={isSessionScoped}
          onClose={() => setExecTarget(null)}
        />
      ) : null}

      <ConfirmDialog
        isOpen={confirmDialogConfig.isOpen}
        type="warning"
        title={confirmDialogConfig.title}
        message={confirmDialogConfig.message}
        confirmText={confirmDialogConfig.confirmText}
        onConfirm={confirmDialogConfig.onConfirm}
        onCancel={confirmDialogConfig.onCancel}
      />
    </div>,
    portalTarget,
  );
}
