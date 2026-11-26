import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Clock, Cpu, HardDrive, Loader2, MemoryStick, Network, Play, Plus, Power, RefreshCw, RotateCcw, Save, ScrollText, Server, Shield, Skull, Square, Trash2, X } from 'lucide-react';
import type { CrontabResult, FirewallStatusResult, ListeningPortItem, ServerMonitorMetrics, SystemdServiceItem } from '../../../shared/ipc-types';
import { useConnectionStore } from '../../store/useConnectionStore';
import { IndustrialSelect } from '../../shared-ui/IndustrialSelect';

interface ServerMonitorButtonProps {
  connectionId: string | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

const REFRESH_INTERVAL_MS = 5000;
/** sparkline 保留最近多少个采样点（5s × 60 = 5 分钟）。 */
const HISTORY_LIMIT = 60;
const MAX_VISIBLE_NETWORKS = 5;

/** KB → 人类可读（监控指标以 KB 计）。 */
function formatKb(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return '0 B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = kb;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** 字节/秒 → 人类可读速率（复用 formatKb 的 1024 进制）。 */
function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${formatKb(bytesPerSec / 1024)}/s`;
}

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = clamped >= 90 ? 'bg-danger' : clamped >= 70 ? 'bg-warning' : 'bg-accent';
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="truncate font-medium text-fg-secondary" title={label}>{label}</span>
        <span className="ml-2 shrink-0 font-mono text-[11px] font-medium text-fg-muted tabular-nums">{clamped.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-line-subtle">
        <div
          className={`h-full rounded-full ${tone} transition-all duration-500`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <p className="mt-1 font-mono text-[10.5px] text-fg-subtle tabular-nums">{detail}</p>
    </div>
  );
}

/** 迷你折线（支持固定 0–100% 或自动量程，带柔和面积渐变与末端指示点）。 */
function Sparkline({
  values,
  autoScale = false,
  toneClass = 'text-accent',
}: {
  values: number[];
  autoScale?: boolean;
  toneClass?: string;
}) {
  const gradientId = useId();
  const width = 100;
  const height = 28;
  const padY = 2;
  const { points, areaPoints, lastPoint } = useMemo(() => {
    if (values.length === 0) {
      return { points: '', areaPoints: '', lastPoint: null as { x: number; y: number } | null };
    }
    const maxVal = autoScale ? Math.max(1, ...values) : 100;
    const step = values.length > 1 ? width / (values.length - 1) : width;
    const coords = values.map((value, index) => {
      const ratio = Math.max(0, Math.min(1, value / maxVal));
      const x = index * step;
      const y = height - padY - ratio * (height - padY * 2);
      return { x, y };
    });
    const line = coords.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    const area = `0,${height} ${line} ${coords[coords.length - 1].x.toFixed(1)},${height}`;
    return { points: line, areaPoints: area, lastPoint: coords[coords.length - 1] };
  }, [values, autoScale]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`h-8 w-full ${toneClass}`}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {areaPoints && (
        <polygon points={areaPoints} fill={`url(#${gradientId})`} />
      )}
      <polyline
        points={points || `0,${height - padY}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {lastPoint && (
        <circle cx={lastPoint.x} cy={lastPoint.y} r="2" fill="currentColor" />
      )}
    </svg>
  );
}

function Card({
  icon,
  tint,
  title,
  right,
  children,
}: {
  icon: ReactNode;
  tint: string;
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2 rounded-lg border border-line-subtle bg-[color-mix(in_srgb,var(--bg-secondary)_92%,transparent)] p-3 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-fg">
          <span className={`inline-flex h-5 w-5 items-center justify-center rounded-sm ${tint}`}>{icon}</span>
          {title}
        </span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[11px] text-fg-subtle">{label}</div>
      <div className="truncate font-mono text-fg tabular-nums" title={value}>{value || '—'}</div>
    </div>
  );
}

/**
 * 终端工具栏的服务器监控按钮：点击在下方弹出指标卡片，再次点击收起。
 * 数据经 SSH 采集命令（/proc + /sys + df + uname）获得，目标机零安装。仅在 Web 端
 * （getServerMonitor 可用）且存在活动连接时渲染；桌面端方法缺失时自动隐藏。
 */
export function ServerMonitorButton({ connectionId, translate }: ServerMonitorButtonProps) {
  const supported = typeof window !== 'undefined'
    && typeof window.electronAPI?.getServerMonitor === 'function';
  const [open, setOpen] = useState(false);
  const [monitorTab, setMonitorTab] = useState<'overview' | 'ports' | 'services' | 'crontab' | 'firewall'>('overview');
  const [metrics, setMetrics] = useState<ServerMonitorMetrics | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const [netHistory, setNetHistory] = useState<number[]>([]);
  const [ports, setPorts] = useState<ListeningPortItem[]>([]);
  const [services, setServices] = useState<SystemdServiceItem[]>([]);
  const [serviceFilter, setServiceFilter] = useState('');
  const [serviceLogs, setServiceLogs] = useState<{ name: string; logs: string; loading: boolean } | null>(null);
  const [servicesAvailable, setServicesAvailable] = useState(true);
  const [crontab, setCrontab] = useState<CrontabResult | null>(null);
  const [crontabDraft, setCrontabDraft] = useState('');
  const [crontabSaving, setCrontabSaving] = useState(false);
  const [firewall, setFirewall] = useState<FirewallStatusResult | null>(null);
  const [fwPort, setFwPort] = useState('');
  const [fwProtocol, setFwProtocol] = useState<'tcp' | 'udp' | 'any'>('tcp');
  const [fwBusy, setFwBusy] = useState(false);
  const [extraLoading, setExtraLoading] = useState(false);
  const [confirmKillPid, setConfirmKillPid] = useState<number | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllNetworks, setShowAllNetworks] = useState(false);
  const [showAllCores, setShowAllCores] = useState(false);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const requestSeq = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const connections = useConnectionStore(state => state.connections);
  const loadConnections = useConnectionStore(state => state.loadConnections);
  const connection = useMemo(
    () => connections.find(item => item.id === connectionId) || null,
    [connections, connectionId],
  );

  const fetchMetrics = useCallback(async () => {
    const api = window.electronAPI?.getServerMonitor;
    if (!api || !connectionId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api(connectionId);
      if (seq !== requestSeq.current) return;
      if (result.success && result.data) {
        const nextMetrics = result.data;
        setMetrics(nextMetrics);
        setHistory(prev => {
          const next = [...prev, nextMetrics.cpuPercent];
          return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
        });
        setMemHistory(prev => {
          const next = [...prev, nextMetrics.memory?.percent ?? 0];
          return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
        });
        const netTotal = (nextMetrics.network ?? [])
          .filter((item) => item.name !== 'lo')
          .reduce((sum, item) => sum + (item.rxBytesPerSec || 0) + (item.txBytesPerSec || 0), 0);
        setNetHistory(prev => {
          const next = [...prev, netTotal];
          return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
        });
      } else {
        setError(result.success ? translate('features.monitor.failed') : (result.error || translate('features.monitor.failed')));
      }
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err instanceof Error ? err.message : translate('features.monitor.failed'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [connectionId, translate]);

  // 打开时立即采集并按间隔自动刷新；关闭/卸载时停止。
  useEffect(() => {
    if (!open || !supported || !connectionId) return;
    if (connections.length === 0) void loadConnections();
    void fetchMetrics();
    const timer = setInterval(() => { void fetchMetrics(); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, supported, connectionId, fetchMetrics, connections.length, loadConnections]);

  const fetchExtraTab = useCallback(async (tab: 'ports' | 'services' | 'crontab' | 'firewall') => {
    if (!connectionId) return;
    setExtraLoading(true);
    setActionMsg(null);
    setError(null);
    try {
      if (tab === 'ports' && window.electronAPI?.listListeningPorts) {
        const res = await window.electronAPI.listListeningPorts(connectionId);
        if (res.success) setPorts(res.data.ports || []);
        else setError(res.error);
      } else if (tab === 'services' && window.electronAPI?.listSystemdServices) {
        const res = await window.electronAPI.listSystemdServices(connectionId);
        if (res.success) {
          setServicesAvailable(res.data.available);
          setServices(res.data.services || []);
        } else {
          setError(res.error);
        }
      } else if (tab === 'crontab' && window.electronAPI?.getCrontab) {
        const res = await window.electronAPI.getCrontab(connectionId);
        if (res.success) {
          setCrontab(res.data);
          setCrontabDraft(res.data.raw || '');
        } else {
          setError(res.error);
        }
      } else if (tab === 'firewall' && window.electronAPI?.getFirewallStatus) {
        const res = await window.electronAPI.getFirewallStatus(connectionId);
        if (res.success) {
          setFirewall(res.data);
        } else {
          setError(res.error);
        }
      }
    } finally {
      setExtraLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    if (!open || !connectionId) return;
    if (monitorTab !== 'overview') {
      void fetchExtraTab(monitorTab);
    }
  }, [open, connectionId, monitorTab, fetchExtraTab]);

  // 连接切换时清空旧指标/历史并收起，避免展示上一台主机的数据。
  useEffect(() => {
    setMetrics(null);
    setHistory([]);
    setMemHistory([]);
    setNetHistory([]);
    setPorts([]);
    setServices([]);
    setServiceFilter('');
    setServiceLogs(null);
    setCrontab(null);
    setCrontabDraft('');
    setFirewall(null);
    setFwPort('');
    setMonitorTab('overview');
    setConfirmKillPid(null);
    setActionMsg(null);
    setError(null);
    setOpen(false);
    setShowAllNetworks(false);
    setShowAllCores(false);
    setPanelPosition(null);
  }, [connectionId]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      if (target.closest('[data-monitor-submodal]') || target.closest('[role="listbox"]')) {
        return;
      }
      setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = window.innerHeight;
      const margin = 12;
      const width = Math.max(0, Math.min(400, viewportWidth - margin * 2));
      const maxHeight = Math.max(0, Math.min(viewportHeight * 0.82, viewportHeight - margin * 2));
      panel.style.width = `${width}px`;
      panel.style.maxHeight = `${maxHeight}px`;

      const triggerRect = trigger.getBoundingClientRect();
      const panelHeight = panel.getBoundingClientRect().height;
      const maxLeft = Math.max(margin, viewportWidth - width - margin);
      const left = Math.min(maxLeft, Math.max(margin, triggerRect.right - width));
      const maxTop = Math.max(margin, viewportHeight - panelHeight - margin);
      const below = triggerRect.bottom + 8;
      const preferredTop = below <= maxTop ? below : triggerRect.top - panelHeight - 8;
      const top = Math.min(maxTop, Math.max(margin, preferredTop));

      setPanelPosition((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    };

    updatePosition();
    const resizeObserver = typeof ResizeObserver !== 'undefined' && panelRef.current
      ? new ResizeObserver(() => updatePosition())
      : null;
    if (resizeObserver && panelRef.current) {
      resizeObserver.observe(panelRef.current);
    }
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, metrics, showAllNetworks, showAllCores, error]);

  if (!supported || !connectionId) return null;

  const address = connection ? `${connection.username}@${connection.host}` : '';
  const coreCount = metrics?.coreCount ?? metrics?.cpuCores?.length ?? 0;
  const networkList = metrics?.network ?? [];
  const sortedNetworkList = [...networkList]
    .filter((network) => network.name !== 'lo')
    .sort((a, b) => (b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec));
  const visibleNetworkList = showAllNetworks
    ? sortedNetworkList
    : sortedNetworkList.slice(0, MAX_VISIBLE_NETWORKS);
  const processCpu = (metrics?.processCpu ?? []).slice(0, 10);
  const diskList = metrics?.disks && metrics.disks.length > 0 ? metrics.disks : null;
  const memory = metrics?.memory;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className={`terminal-control ${open ? 'terminal-control-active' : ''}`}
        title={translate('features.monitor.button')}
        aria-label={translate('features.monitor.button')}
        data-terminal-monitor-toggle
      >
        <Activity className="w-4 h-4" />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          className="app-popover fixed left-3 top-3 z-overlay mt-0 max-h-[82vh] w-[400px] space-y-2.5 overflow-y-auto p-3 scrollbar-thin"
          data-terminal-monitor-panel
          data-terminal-toolbar-popup
          style={{
            position: 'fixed',
            left: panelPosition?.left ?? 12,
            top: panelPosition?.top ?? 12,
            visibility: panelPosition ? 'visible' : 'hidden',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-fg">
              <Activity className="h-4 w-4 shrink-0 text-accent" />
              <span className="truncate">{translate('features.monitor.title')}</span>
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => { void fetchMetrics(); }}
                className="icon-button h-6 w-6"
                title={translate('common.refresh')}
                aria-label={translate('common.refresh')}
                disabled={loading}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="icon-button h-6 w-6"
                title={translate('common.close')}
                aria-label={translate('common.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1 border-b border-line-subtle pb-1.5">
            {([
              { id: 'overview', label: translate('features.monitor.tabs.overview') },
              { id: 'ports', label: translate('features.monitor.tabs.ports') },
              { id: 'services', label: translate('features.monitor.tabs.services') },
              { id: 'crontab', label: translate('features.monitor.tabs.crontab') },
              { id: 'firewall', label: translate('features.monitor.tabs.firewall') },
            ] as const).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setMonitorTab(tab.id)}
                className={`rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors ${
                  monitorTab === tab.id
                    ? 'bg-accent-muted text-accent'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {actionMsg && (
            <div className="rounded-sm border border-accent bg-accent-muted px-2 py-1 text-[11px] text-accent">
              {actionMsg}
            </div>
          )}

          {error && (
            <div className="space-y-1.5 rounded-md border border-[color-mix(in_srgb,var(--danger)_40%,var(--border-color))] bg-danger-muted px-2.5 py-2 text-xs text-danger-fg">
              <p className="break-words">{translate('features.monitor.failed')}：{error}</p>
              <button
                type="button"
                onClick={() => { void fetchMetrics(); }}
                className="font-medium text-accent hover:underline dark:text-accent-hover"
              >
                {translate('features.monitor.retry')}
              </button>
            </div>
          )}

          {monitorTab === 'ports' && (
            <div className="space-y-1.5">
              {extraLoading ? (
                <div className="flex items-center justify-center gap-2 py-3 text-xs text-fg-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  <span>{translate('common.loading')}</span>
                </div>
              ) : ports.length === 0 ? (
                <p className="py-3 text-center text-xs text-fg-muted">{translate('features.monitor.noPorts')}</p>
              ) : (
                <div className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin">
                  {ports.map((item, idx) => (
                    <div key={`${item.protocol}-${item.address}-${idx}`} className="rounded-sm border border-line-subtle bg-surface px-2 py-1.5 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono font-medium text-fg">{item.address}</span>
                        <span className="shrink-0 rounded-sm bg-surface-raised px-1 py-0.5 font-mono text-[10px] uppercase text-fg-muted">
                          {item.protocol}
                        </span>
                      </div>
                      {item.process && (
                        <div className="mt-0.5 truncate font-mono text-[10px] text-fg-subtle">{item.process}</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {monitorTab === 'services' && (
            <div className="space-y-1.5">
              {servicesAvailable && services.length > 0 && (
                <input
                  type="text"
                  value={serviceFilter}
                  onChange={(event) => setServiceFilter(event.target.value)}
                  placeholder={translate('features.monitor.filterServices')}
                  className="industrial-input h-7 w-full text-[11px]"
                />
              )}
              {extraLoading ? (
                <div className="flex items-center justify-center gap-2 py-3 text-xs text-fg-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  <span>{translate('common.loading')}</span>
                </div>
              ) : !servicesAvailable ? (
                <p className="py-3 text-center text-xs text-fg-muted">{translate('features.monitor.noSystemd')}</p>
              ) : services.length === 0 ? (
                <p className="py-3 text-center text-xs text-fg-muted">{translate('features.monitor.noServices')}</p>
              ) : (
                <div className="max-h-80 space-y-1 overflow-y-auto scrollbar-thin">
                  {services
                    .filter((svc) => !serviceFilter.trim() || svc.name.toLowerCase().includes(serviceFilter.trim().toLowerCase()))
                    .map((svc) => {
                      const active = svc.active === 'active';
                      const isEnabled = svc.enabledState === 'enabled';
                      const canToggleEnable = svc.enabledState === 'enabled' || svc.enabledState === 'disabled';
                      const runSvc = async (action: 'start' | 'stop' | 'restart' | 'enable' | 'disable') => {
                        if (!window.electronAPI?.controlSystemdService || !connectionId) return;
                        const res = await window.electronAPI.controlSystemdService(connectionId, svc.name, action);
                        if (!res.success) {
                          setError(res.error);
                        } else {
                          setActionMsg(`${svc.name}: ${action}`);
                          await fetchExtraTab('services');
                        }
                      };
                      const openLogs = async () => {
                        if (!window.electronAPI?.getSystemdServiceLogs || !connectionId) return;
                        setServiceLogs({ name: svc.name, logs: '', loading: true });
                        const res = await window.electronAPI.getSystemdServiceLogs(connectionId, svc.name, 200);
                        if (!res.success) {
                          setServiceLogs({ name: svc.name, logs: res.error || 'Failed to load logs', loading: false });
                        } else {
                          setServiceLogs({ name: svc.name, logs: res.data.logs || '', loading: false });
                        }
                      };
                      return (
                        <div key={svc.name} className="flex items-center justify-between gap-2 rounded-sm border border-line-subtle bg-surface px-2 py-1.5 text-[11px]">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${active ? 'bg-success' : 'bg-fg-subtle'}`} />
                              <span className="truncate font-mono font-medium text-fg" title={svc.name}>{svc.name}</span>
                              {svc.enabledState && (
                                <span className={`shrink-0 rounded-sm px-1 py-0.2 font-mono text-[9.5px] ${isEnabled ? 'bg-accent-muted text-accent' : 'bg-surface-raised text-fg-subtle'}`}>
                                  {svc.enabledState}
                                </span>
                              )}
                            </div>
                            <div className="truncate text-[10px] text-fg-subtle">{svc.active} ({svc.sub})</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5">
                            <button
                              type="button"
                              onClick={() => { void openLogs(); }}
                              className="icon-button h-6 w-6 text-info"
                              title={translate('features.monitor.serviceLogs')}
                            >
                              <ScrollText className="h-3 w-3" />
                            </button>
                            {canToggleEnable && (
                              <button
                                type="button"
                                onClick={() => { void runSvc(isEnabled ? 'disable' : 'enable'); }}
                                className={`icon-button h-6 w-6 ${isEnabled ? 'text-accent' : 'text-fg-subtle'}`}
                                title={isEnabled ? translate('features.monitor.disableAutostart') : translate('features.monitor.enableAutostart')}
                              >
                                <Power className="h-3 w-3" />
                              </button>
                            )}
                            {!active ? (
                              <button type="button" onClick={() => void runSvc('start')} className="icon-button h-6 w-6 text-success" title={translate('terminal.docker.start')}>
                                <Play className="h-3 w-3" />
                              </button>
                            ) : (
                              <button type="button" onClick={() => void runSvc('stop')} className="icon-button h-6 w-6 text-danger" title={translate('terminal.docker.stop')}>
                                <Square className="h-3 w-3" />
                              </button>
                            )}
                            <button type="button" onClick={() => void runSvc('restart')} className="icon-button h-6 w-6" title={translate('terminal.docker.restart')}>
                              <RotateCcw className="h-3 w-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {monitorTab === 'crontab' && (
            <div className="space-y-2">
              {extraLoading ? (
                <div className="flex items-center justify-center gap-2 py-3 text-xs text-fg-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  <span>{translate('common.loading')}</span>
                </div>
              ) : crontab && !crontab.available ? (
                <p className="py-3 text-center text-xs text-fg-muted">{translate('features.monitor.noCrontab')}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between text-[11px] text-fg-muted">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5 text-accent" />
                      {translate('features.monitor.crontabCount', { count: crontab?.entries.length ?? 0 })}
                    </span>
                    <button
                      type="button"
                      disabled={crontabSaving}
                      onClick={async () => {
                        if (!window.electronAPI?.saveCrontab || !connectionId) return;
                        setCrontabSaving(true);
                        setError(null);
                        try {
                          const res = await window.electronAPI.saveCrontab(connectionId, crontabDraft);
                          if (!res.success) {
                            setError(res.error);
                          } else {
                            setActionMsg(translate('features.monitor.crontabSaved'));
                            await fetchExtraTab('crontab');
                          }
                        } finally {
                          setCrontabSaving(false);
                        }
                      }}
                      className="industrial-button-primary h-6 px-2 text-[11px]"
                    >
                      {crontabSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                      <span>{translate('common.save')}</span>
                    </button>
                  </div>
                  <textarea
                    rows={10}
                    value={crontabDraft}
                    onChange={(event) => setCrontabDraft(event.target.value)}
                    placeholder={'# m h dom mon dow command\n0 3 * * * /usr/local/bin/backup.sh'}
                    className="industrial-input w-full resize-y font-mono text-[11px] leading-5"
                    spellCheck={false}
                  />
                  <p className="text-[10px] text-fg-subtle">{translate('features.monitor.crontabHint')}</p>
                </>
              )}
            </div>
          )}

          {monitorTab === 'firewall' && (
            <div className="space-y-2">
              {extraLoading ? (
                <div className="flex items-center justify-center gap-2 py-3 text-xs text-fg-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                  <span>{translate('common.loading')}</span>
                </div>
              ) : !firewall || firewall.backend === 'none' ? (
                <p className="py-3 text-center text-xs text-fg-muted">{translate('features.monitor.noFirewall')}</p>
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-sm border border-line-subtle bg-surface px-2.5 py-1.5 text-[11px]">
                    <span className="flex items-center gap-1.5 font-medium text-fg">
                      <Shield className="h-3.5 w-3.5 text-accent" />
                      <span className="uppercase">{firewall.backend}</span>
                    </span>
                    <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${firewall.active ? 'bg-success-muted text-success' : 'bg-surface-raised text-fg-muted'}`}>
                      {firewall.active ? translate('features.monitor.firewallActive') : translate('features.monitor.firewallInactive')}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={fwPort}
                      onChange={(event) => setFwPort(event.target.value)}
                      placeholder={translate('features.monitor.firewallPortPlaceholder')}
                      className="industrial-input h-7 min-w-0 flex-1 font-mono text-[11px]"
                    />
                    <div className="w-20 shrink-0">
                      <IndustrialSelect
                        value={fwProtocol}
                        onChange={(val) => setFwProtocol(val as 'tcp' | 'udp' | 'any')}
                        options={[
                          { value: 'tcp', label: 'TCP' },
                          { value: 'udp', label: 'UDP' },
                          { value: 'any', label: 'ANY' },
                        ]}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={fwBusy || !fwPort.trim()}
                      onClick={async () => {
                        if (!window.electronAPI?.manageFirewallRule || !connectionId || firewall.backend === 'none') return;
                        setFwBusy(true);
                        setError(null);
                        try {
                          const res = await window.electronAPI.manageFirewallRule(connectionId, {
                            backend: firewall.backend,
                            action: 'allow',
                            port: fwPort.trim(),
                            protocol: fwProtocol,
                          });
                          if (!res.success) setError(res.error);
                          else {
                            setFwPort('');
                            setActionMsg(translate('features.monitor.firewallRuleUpdated'));
                            await fetchExtraTab('firewall');
                          }
                        } finally {
                          setFwBusy(false);
                        }
                      }}
                      className="industrial-button-primary h-7 shrink-0 px-2 text-[11px]"
                      title={translate('features.monitor.firewallAllow')}
                    >
                      {fwBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                      <span>{translate('features.monitor.firewallAllow')}</span>
                    </button>
                  </div>
                  {firewall.rules.length === 0 ? (
                    <p className="py-2 text-center text-[11px] text-fg-muted">{translate('features.monitor.firewallNoRules')}</p>
                  ) : (
                    <div className="max-h-60 space-y-1 overflow-y-auto scrollbar-thin">
                      {firewall.rules.map((rule) => (
                        <div key={`${rule.id}-${rule.target}`} className="flex items-center justify-between gap-2 rounded-sm border border-line-subtle bg-surface px-2 py-1.5 text-[11px]">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-mono font-medium text-fg">{rule.target}</span>
                              <span className={`shrink-0 rounded-sm px-1 py-0.2 font-mono text-[9.5px] ${rule.action === 'ALLOW' ? 'bg-success-muted text-success' : 'bg-danger-muted text-danger'}`}>
                                {rule.action}
                              </span>
                            </div>
                            <div className="truncate text-[10px] text-fg-subtle">{rule.direction} · {rule.from}</div>
                          </div>
                          <button
                            type="button"
                            disabled={fwBusy}
                            onClick={async () => {
                              if (!window.electronAPI?.manageFirewallRule || !connectionId || firewall.backend === 'none') return;
                              setFwBusy(true);
                              setError(null);
                              try {
                                const res = await window.electronAPI.manageFirewallRule(connectionId, {
                                  backend: firewall.backend,
                                  action: 'delete',
                                  ruleId: rule.id,
                                });
                                if (!res.success) setError(res.error);
                                else {
                                  setActionMsg(translate('features.monitor.firewallRuleUpdated'));
                                  await fetchExtraTab('firewall');
                                }
                              } finally {
                                setFwBusy(false);
                              }
                            }}
                            className="icon-button h-6 w-6 text-danger"
                            title={translate('common.delete')}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {monitorTab === 'overview' && !metrics && !error && (
            <div className="flex items-center gap-2 py-3 text-xs text-fg-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
              <span>{translate('features.monitor.loading')}</span>
            </div>
          )}

          {monitorTab === 'overview' && metrics && (
            <>
              {/* 系统 */}
              <Card
                icon={<Server className="w-3 h-3 text-warning dark:text-warning-fg" />}
                tint="bg-warning-muted"
                title={translate('features.monitor.system')}
              >
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                  <Field label={translate('features.monitor.hostAddress')} value={metrics.hostname} />
                  <Field label={translate('features.monitor.osVersion')} value={metrics.os} />
                  <Field
                    label={translate('features.monitor.kernel')}
                    value={[metrics.kernel, metrics.arch].filter(Boolean).join(' · ')}
                  />
                  <Field
                    label={translate('features.monitor.latency')}
                    value={metrics.latencyMs != null ? `${metrics.latencyMs} ${translate('features.monitor.ms')}` : '—'}
                  />
                  <Field
                    label={translate('features.monitor.connected')}
                    value={formatUptime((metrics.sessionConnectedMs != null ? metrics.sessionConnectedMs / 1000 : metrics.uptimeSeconds))}
                  />
                  <Field
                    label={translate('features.monitor.uptime')}
                    value={formatUptime(metrics.uptimeSeconds)}
                  />
                  <Field
                    label={translate('features.monitor.address')}
                    value={address}
                    className="col-span-2"
                  />
                </div>
                {metrics.processes && (
                  <div className="text-[11px] text-fg-subtle tabular-nums">
                    {translate('features.monitor.processes')}: {metrics.processes.running} / {metrics.processes.total}
                    {metrics.loggedInUsers != null && (
                      <span className="ml-3">{translate('features.monitor.loggedUsers')}: {metrics.loggedInUsers}</span>
                    )}
                  </div>
                )}
              </Card>

              {/* CPU */}
              <Card
                icon={<Cpu className="w-3 h-3 text-accent dark:text-accent-hover" />}
                tint="bg-accent-muted"
                title={translate('features.monitor.cpu')}
                right={coreCount > 0 ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised text-fg-secondary tabular-nums">
                    {translate('features.monitor.coreCount', { count: coreCount })}
                  </span>
                ) : undefined}
              >
                <div className="flex items-end gap-2">
                  <span className="text-3xl font-semibold text-accent dark:text-accent-hover tabular-nums leading-none">
                    {metrics.cpuPercent.toFixed(0)}<span className="text-base font-normal">%</span>
                  </span>
                  <span className="text-[11px] text-fg-subtle pb-0.5">{translate('features.monitor.avgUsage')}</span>
                </div>
                <Sparkline values={history} />
                {metrics.cpuCores && metrics.cpuCores.length > 1 && (
                  <div className="text-[11px] text-fg-subtle tabular-nums">
                    <span>
                      {translate('features.monitor.perCore')}:{' '}
                      {(showAllCores ? metrics.cpuCores : metrics.cpuCores.slice(0, 8))
                        .map((value) => `${value}%`)
                        .join(' · ')}
                    </span>
                    {metrics.cpuCores.length > 8 && (
                      <button
                        type="button"
                        onClick={() => setShowAllCores((prev) => !prev)}
                        className="ml-1.5 text-[10px] text-accent hover:text-accent-hover"
                      >
                        {showAllCores
                          ? translate('features.monitor.showLess')
                          : `+${metrics.cpuCores.length - 8}`}
                      </button>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-fg-subtle">{translate('features.monitor.avgLoad')}</span>
                  <span className="text-fg-secondary tabular-nums">
                    {metrics.load.load1.toFixed(2)} · {metrics.load.load5.toFixed(2)} · {metrics.load.load15.toFixed(2)}
                  </span>
                </div>
                {processCpu.length > 0 && (
                  <div className="border-t border-line-subtle pt-2">
                    <div className="mb-1.5 text-[11px] font-medium text-fg-subtle">
                      {translate('features.monitor.topProcesses')}
                    </div>
                    <div className="space-y-1">
                      {processCpu.map((process) => (
                        <div key={process.pid} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 text-[11px]">
                          <span className="truncate text-fg-secondary" title={`${process.name} (${process.pid})`}>
                            {process.name}<span className="ml-1.5 text-fg-faint">{process.pid}</span>
                          </span>
                          <span className="tabular-nums text-accent dark:text-accent-hover">
                            {process.percent.toFixed(1)}%
                          </span>
                          {window.electronAPI?.killRemoteProcess && process.pid > 1 && (
                            confirmKillPid === process.pid ? (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (!connectionId || !window.electronAPI?.killRemoteProcess) return;
                                    const res = await window.electronAPI.killRemoteProcess(connectionId, process.pid, 'TERM');
                                    setConfirmKillPid(null);
                                    if (!res.success) setError(res.error);
                                    else {
                                      setActionMsg(`SIGTERM → PID ${process.pid}`);
                                      void fetchMetrics();
                                    }
                                  }}
                                  className="rounded-sm bg-danger-muted px-1 py-0.5 text-[10px] font-medium text-danger"
                                >
                                  TERM
                                </button>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    if (!connectionId || !window.electronAPI?.killRemoteProcess) return;
                                    const res = await window.electronAPI.killRemoteProcess(connectionId, process.pid, 'KILL');
                                    setConfirmKillPid(null);
                                    if (!res.success) setError(res.error);
                                    else {
                                      setActionMsg(`SIGKILL → PID ${process.pid}`);
                                      void fetchMetrics();
                                    }
                                  }}
                                  className="rounded-sm bg-danger px-1 py-0.5 text-[10px] font-medium text-white"
                                >
                                  KILL
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmKillPid(process.pid)}
                                className="icon-button h-5 w-5 text-fg-subtle hover:text-danger"
                                title={translate('features.monitor.killProcess')}
                              >
                                <Skull className="h-3 w-3" />
                              </button>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>

              {/* GPU（仅存在 NVIDIA GPU 时显示） */}
              {metrics.gpus && metrics.gpus.length > 0 && (
                <Card
                  icon={<Cpu className="w-3 h-3 text-success" />}
                  tint="bg-success-muted"
                  title={translate('features.monitor.gpu')}
                >
                  <div className="space-y-2.5">
                    {metrics.gpus.map((gpu) => (
                      <div key={gpu.index} className="space-y-1.5 rounded-sm border border-line-subtle bg-surface p-2">
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="truncate font-medium text-fg" title={gpu.name}>
                            GPU {gpu.index} · {gpu.name}
                          </span>
                          <span className="shrink-0 font-mono text-[10.5px] text-fg-muted tabular-nums">
                            {gpu.temperatureC}°C{gpu.powerW > 0 ? ` · ${gpu.powerW.toFixed(0)}W` : ''}
                          </span>
                        </div>
                        <Meter
                          label={translate('features.monitor.gpuUtil')}
                          percent={gpu.utilizationPercent}
                          detail={`${gpu.utilizationPercent}%`}
                        />
                        <Meter
                          label={translate('features.monitor.gpuMem')}
                          percent={gpu.memoryPercent}
                          detail={`${gpu.memoryUsedMb} MB / ${gpu.memoryTotalMb} MB`}
                        />
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* 内存 */}
              <Card
                icon={<MemoryStick className="w-3 h-3 text-accent-alt" />}
                tint="bg-accent-alt-muted"
                title={translate('features.monitor.memory')}
              >
                <Meter
                  label={translate('features.monitor.physicalMem')}
                  percent={metrics.memory.percent}
                  detail={`${formatKb(metrics.memory.usedKb)} / ${formatKb(metrics.memory.totalKb)}`}
                />
                {memHistory.length > 1 && (
                  <Sparkline values={memHistory} toneClass="text-accent-alt" />
                )}
                {memory && (memory.swapTotalKb ?? 0) > 0 && (
                  <Meter
                    label={translate('features.monitor.swap')}
                    percent={memory.swapPercent ?? 0}
                    detail={`${formatKb(memory.swapUsedKb ?? 0)} / ${formatKb(memory.swapTotalKb ?? 0)}`}
                  />
                )}
              </Card>

              {/* 网络 */}
              {sortedNetworkList.length > 0 && (
                <Card
                  icon={<Network className="w-3 h-3 text-info dark:text-info-fg" />}
                  tint="bg-info-muted"
                  title={translate('features.monitor.network')}
                  right={sortedNetworkList.length > MAX_VISIBLE_NETWORKS ? (
                    <button
                      type="button"
                      className="text-[10px] text-accent hover:text-accent-hover"
                      onClick={() => setShowAllNetworks((shown) => !shown)}
                    >
                      {showAllNetworks
                        ? translate('features.monitor.showLess')
                        : translate('features.monitor.showAllInterfaces', { count: sortedNetworkList.length })}
                    </button>
                  ) : undefined}
                >
                  <div className="space-y-1">
                    {netHistory.length > 1 && (
                      <Sparkline values={netHistory} autoScale toneClass="text-info" />
                    )}
                    {visibleNetworkList.map((net) => (
                      <div key={net.name} className="flex items-center justify-between text-[11px]">
                        <span className="mr-2 truncate text-fg-secondary" title={net.name}>{net.name}</span>
                        <span className="shrink-0 font-mono text-fg-secondary tabular-nums">
                          <span className="text-warning-fg">↑</span> {formatRate(net.txBytesPerSec)}
                          <span className="mx-1.5 text-fg-faint">·</span>
                          <span className="text-accent dark:text-accent-hover">↓</span> {formatRate(net.rxBytesPerSec)}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* 磁盘 */}
              <Card
                icon={<HardDrive className="w-3 h-3 text-accent-strong" />}
                tint="bg-accent-strong-muted"
                title={translate('features.monitor.disks')}
              >
                <div className="space-y-2">
                  {diskList
                    ? diskList.map((disk) => (
                        <Meter
                          key={disk.mount}
                          label={disk.mount}
                          percent={disk.percent}
                          detail={`${translate('features.monitor.used')} ${formatKb(disk.usedKb)} / ${formatKb(disk.totalKb)}`}
                        />
                      ))
                    : (
                        <Meter
                          label="/"
                          percent={metrics.disk.percent}
                          detail={`${translate('features.monitor.used')} ${formatKb(metrics.disk.usedKb)} / ${formatKb(metrics.disk.totalKb)}`}
                        />
                      )}
                </div>
                {metrics.diskIo && (
                  <div className="flex items-center justify-between text-[11px] text-fg-muted">
                    <span>{translate('features.monitor.diskIo')}</span>
                    <span className="font-mono text-fg-secondary tabular-nums">
                      <span className="text-accent dark:text-accent-hover">↓</span> {formatRate(metrics.diskIo.readBytesPerSec)}
                      <span className="mx-1.5 text-fg-faint">·</span>
                      <span className="text-warning-fg">↑</span> {formatRate(metrics.diskIo.writeBytesPerSec)}
                    </span>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>,
        document.body,
      )}

      {serviceLogs && createPortal(
        <div
          data-monitor-submodal
          className="fixed inset-0 z-modal flex items-center justify-center p-4"
          onClick={() => setServiceLogs(null)}
        >
          <div className="modal-backdrop" />
          <div
            className="industrial-modal relative flex h-[72vh] w-full max-w-4xl flex-col overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="industrial-modal-header shrink-0 text-sm font-semibold text-fg">
              <span className="truncate font-mono">journalctl · {serviceLogs.name}</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={serviceLogs.loading}
                  onClick={async () => {
                    if (!window.electronAPI?.getSystemdServiceLogs || !connectionId) return;
                    setServiceLogs((prev) => (prev ? { ...prev, loading: true } : null));
                    const res = await window.electronAPI.getSystemdServiceLogs(connectionId, serviceLogs.name, 200);
                    setServiceLogs({
                      name: serviceLogs.name,
                      logs: res.success ? (res.data.logs || '') : (res.error || ''),
                      loading: false,
                    });
                  }}
                  className="icon-button h-7 w-7"
                  title={translate('common.refresh')}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${serviceLogs.loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setServiceLogs(null)}
                  className="icon-button h-7 w-7"
                  title={translate('common.close')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <pre className="scrollbar-thin min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-[var(--bg-primary)] p-3 font-mono text-[11px] leading-5 text-fg-secondary">
              {serviceLogs.loading ? translate('common.loading') : (serviceLogs.logs || translate('terminal.docker.logsEmpty'))}
            </pre>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
