import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Cpu, HardDrive, Loader2, MemoryStick, Network, RefreshCw, Server, X } from 'lucide-react';
import type { ServerMonitorMetrics } from '../../../shared/ipc-types';
import { useConnectionStore } from '../../store/useConnectionStore';

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

/** CPU 使用率迷你折线（0–100% 归一化，带柔和面积渐变与末端指示点）。 */
function Sparkline({ values }: { values: number[] }) {
  const gradientId = useId();
  const width = 100;
  const height = 30;
  const padY = 2;
  const { points, areaPoints, lastPoint } = useMemo(() => {
    if (values.length === 0) {
      return { points: '', areaPoints: '', lastPoint: null as { x: number; y: number } | null };
    }
    const step = values.length > 1 ? width / (values.length - 1) : width;
    const coords = values.map((value, index) => {
      const clamped = Math.max(0, Math.min(100, value));
      const x = index * step;
      const y = height - padY - (clamped / 100) * (height - padY * 2);
      return { x, y };
    });
    const line = coords.map((pt) => `${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    const area = `0,${height} ${line} ${coords[coords.length - 1].x.toFixed(1)},${height}`;
    return { points: line, areaPoints: area, lastPoint: coords[coords.length - 1] };
  }, [values]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-8 w-full text-accent">
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
  const [metrics, setMetrics] = useState<ServerMonitorMetrics | null>(null);
  const [history, setHistory] = useState<number[]>([]);
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
        setMetrics(result.data);
        setHistory(prev => {
          const next = [...prev, result.data!.cpuPercent];
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

  // 连接切换时清空旧指标/历史并收起，避免展示上一台主机的数据。
  useEffect(() => {
    setMetrics(null);
    setHistory([]);
    setError(null);
    setOpen(false);
    setShowAllNetworks(false);
    setShowAllCores(false);
    setPanelPosition(null);
  }, [connectionId]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) {
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
      const width = Math.max(0, Math.min(340, viewportWidth - margin * 2));
      const maxHeight = Math.max(0, Math.min(viewportHeight * 0.78, viewportHeight - margin * 2));
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
          className="app-popover fixed left-3 top-3 z-overlay mt-0 max-h-[78vh] w-[340px] space-y-2.5 overflow-y-auto p-3 scrollbar-thin"
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

          {!metrics && !error && (
            <div className="flex items-center gap-2 py-3 text-xs text-fg-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
              <span>{translate('features.monitor.loading')}</span>
            </div>
          )}

          {metrics && (
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
                        <div key={process.pid} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-[11px]">
                          <span className="truncate text-fg-secondary" title={`${process.name} (${process.pid})`}>
                            {process.name}<span className="ml-1.5 text-fg-faint">{process.pid}</span>
                          </span>
                          <span className="tabular-nums text-accent dark:text-accent-hover">
                            {process.percent.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>

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
    </div>
  );
}
