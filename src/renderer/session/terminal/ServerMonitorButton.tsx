import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Cpu, HardDrive, MemoryStick, Network, RefreshCw, Server, X } from 'lucide-react';
import type { ServerMonitorMetrics } from '../../../shared/ipc-types';
import { useConnectionStore } from '../../store/useConnectionStore';

interface ServerMonitorButtonProps {
  connectionId: string | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

const REFRESH_INTERVAL_MS = 5000;
/** sparkline 保留最近多少个采样点（5s × 60 = 5 分钟）。 */
const HISTORY_LIMIT = 60;

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
  const tone = clamped >= 90 ? 'bg-red-500' : clamped >= 70 ? 'bg-amber-500' : 'bg-teal-500';
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-slate-600 dark:text-slate-300 font-medium truncate" title={label}>{label}</span>
        <span className="text-slate-500 dark:text-slate-400 tabular-nums shrink-0 ml-2">{clamped.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${clamped}%` }} />
      </div>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 tabular-nums">{detail}</p>
    </div>
  );
}

/** CPU 使用率迷你折线（0–100% 归一化）。 */
function Sparkline({ values }: { values: number[] }) {
  const width = 100;
  const height = 28;
  const points = useMemo(() => {
    if (values.length === 0) return '';
    const step = values.length > 1 ? width / (values.length - 1) : width;
    return values
      .map((value, index) => {
        const clamped = Math.max(0, Math.min(100, value));
        const x = index * step;
        const y = height - (clamped / 100) * height;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [values]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-7 text-teal-500">
      <polyline
        points={points || `0,${height}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
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
    <div className="rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-[color-mix(in_srgb,var(--border-color)_60%,transparent)] p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200">
          <span className={`inline-flex items-center justify-center w-5 h-5 rounded-md ${tint}`}>{icon}</span>
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
      <div className="text-[11px] text-slate-400 dark:text-slate-500">{label}</div>
      <div className="text-slate-700 dark:text-slate-200 truncate tabular-nums" title={value}>{value || '—'}</div>
    </div>
  );
}

/**
 * 终端工具栏的服务器监控按钮：点击在下方弹出指标卡片，再次点击收起。
 * 数据经 SSH 采集命令（/proc + df + uname）获得，目标机零安装。仅在 Web 端
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
  const requestSeq = useRef(0);

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
  }, [connectionId]);

  if (!supported || !connectionId) return null;

  const address = connection ? `${connection.username}@${connection.host}` : '';
  const coreCount = metrics?.coreCount ?? metrics?.cpuCores?.length ?? 0;
  const networkList = metrics?.network ?? [];
  const diskList = metrics?.disks && metrics.disks.length > 0 ? metrics.disks : null;
  const memory = metrics?.memory;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(prev => !prev)}
        className={`terminal-control ${open ? 'terminal-control-active' : ''}`}
        title={translate('features.monitor.button')}
        aria-label={translate('features.monitor.button')}
        data-terminal-monitor-toggle
      >
        <Activity className="w-4 h-4" />
      </button>

      {open && (
        <div
          className="app-popover right-0 top-full mt-1 w-[340px] max-h-[75vh] overflow-y-auto p-3 space-y-2.5 z-50"
          data-terminal-monitor-panel
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-teal-500" />
              {translate('features.monitor.title')}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => { void fetchMetrics(); }}
                className="icon-button h-6 w-6"
                title={translate('common.refresh')}
                disabled={loading}
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="icon-button h-6 w-6"
                title={translate('common.close')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 space-y-1">
              <p>{translate('features.monitor.failed')}：{error}</p>
              <button
                type="button"
                onClick={() => { void fetchMetrics(); }}
                className="text-teal-600 dark:text-teal-400 hover:underline"
              >
                {translate('features.monitor.retry')}
              </button>
            </div>
          )}

          {!metrics && !error && (
            <p className="text-xs text-slate-400 dark:text-slate-500 py-2">{translate('features.monitor.loading')}</p>
          )}

          {metrics && (
            <>
              {/* 系统 */}
              <Card
                icon={<Server className="w-3 h-3 text-amber-600 dark:text-amber-400" />}
                tint="bg-amber-500/15"
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
                  <div className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                    {translate('features.monitor.processes')}: {metrics.processes.running} / {metrics.processes.total}
                    {metrics.loggedInUsers != null && (
                      <span className="ml-3">{translate('features.monitor.loggedUsers')}: {metrics.loggedInUsers}</span>
                    )}
                  </div>
                )}
              </Card>

              {/* CPU */}
              <Card
                icon={<Cpu className="w-3 h-3 text-teal-600 dark:text-teal-400" />}
                tint="bg-teal-500/15"
                title={translate('features.monitor.cpu')}
                right={coreCount > 0 ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 tabular-nums">
                    {translate('features.monitor.coreCount', { count: coreCount })}
                  </span>
                ) : undefined}
              >
                <div className="flex items-end gap-2">
                  <span className="text-3xl font-semibold text-teal-600 dark:text-teal-400 tabular-nums leading-none">
                    {metrics.cpuPercent.toFixed(0)}<span className="text-base font-normal">%</span>
                  </span>
                  <span className="text-[11px] text-slate-400 dark:text-slate-500 pb-0.5">{translate('features.monitor.avgUsage')}</span>
                </div>
                <Sparkline values={history} />
                {metrics.cpuCores && metrics.cpuCores.length > 1 && (
                  <div className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
                    {translate('features.monitor.perCore')}:{' '}
                    {metrics.cpuCores.map((value, index) => `${value}%`).join(' · ')}
                  </div>
                )}
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400 dark:text-slate-500">{translate('features.monitor.avgLoad')}</span>
                  <span className="text-slate-600 dark:text-slate-300 tabular-nums">
                    {metrics.load.load1.toFixed(2)} · {metrics.load.load5.toFixed(2)} · {metrics.load.load15.toFixed(2)}
                  </span>
                </div>
              </Card>

              {/* 内存 */}
              <Card
                icon={<MemoryStick className="w-3 h-3 text-violet-600 dark:text-violet-400" />}
                tint="bg-violet-500/15"
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
              {networkList.length > 0 && (
                <Card
                  icon={<Network className="w-3 h-3 text-sky-600 dark:text-sky-400" />}
                  tint="bg-sky-500/15"
                  title={translate('features.monitor.network')}
                >
                  <div className="space-y-1">
                    {networkList.map((net) => (
                      <div key={net.name} className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-600 dark:text-slate-300 truncate mr-2" title={net.name}>{net.name}</span>
                        <span className="tabular-nums shrink-0">
                          <span className="text-amber-600 dark:text-amber-400">↑</span> {formatRate(net.txBytesPerSec)}
                          <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                          <span className="text-teal-600 dark:text-teal-400">↓</span> {formatRate(net.rxBytesPerSec)}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* 磁盘 */}
              <Card
                icon={<HardDrive className="w-3 h-3 text-orange-600 dark:text-orange-400" />}
                tint="bg-orange-500/15"
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
                  <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                    <span>{translate('features.monitor.diskIo')}</span>
                    <span className="tabular-nums">
                      <span className="text-teal-600 dark:text-teal-400">↓</span> {formatRate(metrics.diskIo.readBytesPerSec)}
                      <span className="mx-1.5 text-slate-300 dark:text-slate-600">·</span>
                      <span className="text-amber-600 dark:text-amber-400">↑</span> {formatRate(metrics.diskIo.writeBytesPerSec)}
                    </span>
                  </div>
                )}
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
