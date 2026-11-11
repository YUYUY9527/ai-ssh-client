import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw, X } from 'lucide-react';
import type { ServerMonitorMetrics } from '../../../shared/ipc-types';

interface ServerMonitorButtonProps {
  connectionId: string | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

const REFRESH_INTERVAL_MS = 5000;

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
        <span className="text-slate-600 dark:text-slate-300 font-medium">{label}</span>
        <span className="text-slate-500 dark:text-slate-400 tabular-nums">{clamped.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${clamped}%` }} />
      </div>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 tabular-nums">{detail}</p>
    </div>
  );
}

/**
 * 终端工具栏的服务器监控按钮：点击在下方弹出指标卡片，再次点击收起。
 * 数据经 SSH 采集命令（/proc + df）获得，目标机零安装。仅在 Web 端
 * （getServerMonitor 可用）且存在活动连接时渲染；桌面端方法缺失时自动隐藏。
 */
export function ServerMonitorButton({ connectionId, translate }: ServerMonitorButtonProps) {
  const supported = typeof window !== 'undefined'
    && typeof window.electronAPI?.getServerMonitor === 'function';
  const [open, setOpen] = useState(false);
  const [metrics, setMetrics] = useState<ServerMonitorMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

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
    void fetchMetrics();
    const timer = setInterval(() => { void fetchMetrics(); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, supported, connectionId, fetchMetrics]);

  // 连接切换时清空旧指标并收起，避免展示上一台主机的数据。
  useEffect(() => {
    setMetrics(null);
    setError(null);
    setOpen(false);
  }, [connectionId]);

  if (!supported || !connectionId) return null;

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
          className="app-popover right-0 top-full mt-1 w-[300px] p-3 space-y-3 z-50"
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
              <Meter
                label={translate('features.monitor.cpu')}
                percent={metrics.cpuPercent}
                detail={`${translate('features.monitor.load')}: ${metrics.load.load1.toFixed(2)} / ${metrics.load.load5.toFixed(2)} / ${metrics.load.load15.toFixed(2)}`}
              />
              <Meter
                label={translate('features.monitor.memory')}
                percent={metrics.memory.percent}
                detail={`${translate('features.monitor.used')} ${formatKb(metrics.memory.usedKb)} / ${formatKb(metrics.memory.totalKb)}`}
              />
              <Meter
                label={translate('features.monitor.disk')}
                percent={metrics.disk.percent}
                detail={`${translate('features.monitor.used')} ${formatKb(metrics.disk.usedKb)} / ${formatKb(metrics.disk.totalKb)}`}
              />
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
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400 pt-1 border-t border-[color-mix(in_srgb,var(--border-color)_70%,transparent)]">
                <span className="truncate" title={metrics.hostname}>{translate('features.monitor.hostname')}: {metrics.hostname || '—'}</span>
                <span>{translate('features.monitor.uptime')}: {formatUptime(metrics.uptimeSeconds)}</span>
                <span className="col-span-2 truncate" title={metrics.os}>{translate('features.monitor.os')}: {metrics.os || '—'}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}