import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Cpu, Gauge, HardDrive, MemoryStick } from 'lucide-react';

import { useI18n } from '../i18n';
import { useSessionStore } from '../session/useSessionStore';
import type { ServerMonitorMetrics } from '../../shared/ipc-types';

/**
 * 底栏右侧的服务器实时指标（CPU / 内存 / 交换 / 磁盘 / 网络 / 负载 / 延迟）。
 *
 * 数据来自 `getServerMonitor`（SSH 采集，目标机零安装），与工具栏的监控卡片同源。
 * 只在当前活动会话存在时、且页面可见时每 5 秒轮询一次；组件自订阅 store，
 * 刷新只重渲染这一小条，不会带着整棵终端树一起重画。
 * 桌面端没有 getServerMonitor 时整条隐藏（feature-detect）。
 */

const REFRESH_INTERVAL_MS = 5000;

/** KB → 人类可读（指标以 KB 计）。 */
function formatKb(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return '0B';
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = kb;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded}${units[unit]}`;
}

/** 字节/秒 → 人类可读速率。 */
function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0B/s';
  return `${formatKb(bytesPerSec / 1024)}/s`;
}

function Segment({
  icon,
  title,
  value,
  tone = 'text-accent dark:text-accent-hover',
}: {
  icon: ReactNode;
  title: string;
  value: string;
  tone?: string;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1" title={title}>
      <span className="text-fg-subtle">{icon}</span>
      <span className={`tabular-nums ${tone}`}>{value}</span>
    </span>
  );
}

export function FooterServerMonitor() {
  const { t } = useI18n();
  const connectionId = useSessionStore(state => state.activeSessionId);
  // 只有会话真正连上（state === 'connected'）后才开始轮询：连接中/重连中一律不请求，
  // 避免在握手窗口里和真正的连接流程抢通道、把连接拖慢。
  const isConnected = useSessionStore((state) => {
    const id = state.activeSessionId;
    return id ? state.sessions[id]?.state === 'connected' : false;
  });
  const supported = typeof window !== 'undefined'
    && typeof window.electronAPI?.getServerMonitor === 'function';

  const [metrics, setMetrics] = useState<ServerMonitorMetrics | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    setMetrics(null);
  }, [connectionId]);

  useEffect(() => {
    if (!supported || !connectionId || !isConnected) return;
    const api = window.electronAPI?.getServerMonitor;
    if (!api) return;

    const fetchMetrics = async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      const seq = ++requestSeq.current;
      try {
        const result = await api(connectionId);
        if (seq !== requestSeq.current) return;
        if (result.success && result.data) setMetrics(result.data);
      } catch {
        // 底栏静默：采集失败保留上一次的好数据，不在这里刷错误提示（有监控卡片兜底）。
      }
    };

    void fetchMetrics();
    const timer = window.setInterval(fetchMetrics, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [supported, connectionId, isConnected]);

  if (!supported || !connectionId || !metrics) return null;

  const mem = metrics.memory;
  const swapTotalKb = mem?.swapTotalKb ?? 0;
  const rootDiskPercent = metrics.disks?.find(d => d.mount === '/')?.percent ?? metrics.disk?.percent ?? 0;
  const net = (metrics.network ?? []).filter(n => n.name !== 'lo');
  const rxTotal = net.reduce((sum, n) => sum + (n.rxBytesPerSec || 0), 0);
  const txTotal = net.reduce((sum, n) => sum + (n.txBytesPerSec || 0), 0);
  const load1 = metrics.load?.load1;

  return (
    <div className="app-footer-meta min-w-0 text-[11px]">
      <Segment
        icon={<Cpu className="h-3 w-3" />}
        title={t('features.monitor.cpu')}
        value={`${Math.round(metrics.cpuPercent || 0)}%`}
      />
      <Segment
        icon={<MemoryStick className="h-3 w-3" />}
        title={t('features.monitor.memory')}
        value={`${formatKb(mem?.usedKb ?? 0)}/${formatKb(mem?.totalKb ?? 0)}`}
      />
      {swapTotalKb > 0 && (
        <Segment
          icon={<MemoryStick className="h-3 w-3" />}
          title={t('features.monitor.swap')}
          value={`${t('features.monitor.swap')} ${formatKb(mem?.swapUsedKb ?? 0)}/${formatKb(swapTotalKb)}`}
          tone="text-fg-muted"
        />
      )}
      <Segment
        icon={<HardDrive className="h-3 w-3" />}
        title={t('features.monitor.disk')}
        value={`${Math.round(rootDiskPercent)}%`}
      />
      <span className="flex shrink-0 items-center gap-1" title={t('features.monitor.network')}>
        <ArrowUp className="h-3 w-3 text-success" />
        <span className="tabular-nums text-success dark:text-success-fg">{formatRate(txTotal)}</span>
        <ArrowDown className="h-3 w-3 text-info" />
        <span className="tabular-nums text-info dark:text-info-fg">{formatRate(rxTotal)}</span>
      </span>
      {typeof load1 === 'number' && (
        <span className="hidden shrink-0 items-center gap-1 xl:flex" title={t('features.monitor.avgLoad')}>
          <Gauge className="h-3 w-3 text-fg-subtle" />
          <span className="tabular-nums text-fg-muted">{load1.toFixed(2)}</span>
        </span>
      )}
      {typeof metrics.latencyMs === 'number' && (
        <span className="flex shrink-0 items-center gap-1" title={t('features.monitor.latency')}>
          <Gauge className="h-3 w-3 text-warning" />
          <span className="tabular-nums text-warning dark:text-warning-fg">
            {Math.round(metrics.latencyMs)} {t('features.monitor.ms')}
          </span>
        </span>
      )}
    </div>
  );
}
