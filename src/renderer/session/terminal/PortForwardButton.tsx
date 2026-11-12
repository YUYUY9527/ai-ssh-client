import { useCallback, useEffect, useState } from 'react';
import { ArrowLeftRight, Play, RefreshCw, Square, X } from 'lucide-react';
import type { PortForwardListResult, PortForwardRuntimeState } from '../../../shared/ipc-types';

interface PortForwardButtonProps {
  connectionId: string | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

const REFRESH_INTERVAL_MS = 3000;

/**
 * 终端工具栏上的端口转发面板：列出当前连接配置的转发规则，
 * 展示本地监听地址 / 连接数 / 运行状态，并可逐条启动或停止。
 */
export function PortForwardButton({ connectionId, translate }: PortForwardButtonProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PortForwardListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);

  const supported =
    typeof window !== 'undefined' && typeof window.electronAPI?.listPortForwards === 'function';

  const fetchForwards = useCallback(async () => {
    const api = window.electronAPI?.listPortForwards;
    if (!api || !connectionId) return;
    try {
      const result = await api(connectionId);
      if (result.success) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [connectionId]);

  useEffect(() => {
    setData(null);
    setError(null);
    if (!connectionId) return;
    const api = window.electronAPI?.listPortForwards;
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api(connectionId);
        if (!cancelled && result.success) setData(result.data);
      } catch {
        // 忽略：取不到规则时按钮保持隐藏。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  useEffect(() => {
    if (!open || !connectionId) return;
    void fetchForwards();
    const timer = window.setInterval(() => {
      void fetchForwards();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, connectionId, fetchForwards]);

  // 该连接未配置任何端口转发规则时，整个入口隐藏。
  if (!supported || !data || data.rules.length === 0) return null;

  const activeFor = (ruleId: string): PortForwardRuntimeState | undefined =>
    data?.active.find((item) => item.ruleId === ruleId);

  const runAction = async (ruleId: string, action: 'start' | 'stop') => {
    const api = action === 'start' ? window.electronAPI?.startPortForward : window.electronAPI?.stopPortForward;
    if (!api || !connectionId) return;
    setBusyRuleId(ruleId);
    try {
      const result = await api(connectionId, ruleId);
      if (!result.success) {
        setError(result.error);
      } else {
        setError(null);
      }
      await fetchForwards();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyRuleId(null);
    }
  };

  const rules = data?.rules ?? [];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className={`terminal-control ${open ? 'terminal-control-active' : ''}`}
        title={translate('features.portForward.title')}
        aria-label={translate('features.portForward.title')}
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="app-popover right-0 top-full mt-1 w-[360px] max-h-[75vh] overflow-y-auto p-3 space-y-2.5 z-dropdown">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-fg">{translate('features.portForward.title')}</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => { void fetchForwards(); }}
                className="icon-button h-6 w-6"
                title={translate('features.portForward.refresh')}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setOpen(false)} className="icon-button h-6 w-6">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {error && <p className="text-[11px] text-danger">{error}</p>}

          {rules.length === 0 ? (
            <p className="text-[11px] text-fg-muted">{translate('features.portForward.empty')}</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => {
                const runtime = activeFor(rule.id);
                const running = runtime?.status === 'running';
                return (
                  <div key={rule.id} className="rounded-xl bg-surface border border-line-subtle p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-medium text-fg" title={rule.label || rule.id}>
                        {rule.label || rule.id}
                      </span>
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-fg-secondary bg-surface-hover">
                        {rule.type === 'dynamic' ? 'SOCKS5' : 'LOCAL'}
                      </span>
                    </div>
                    <div className="text-[11px] text-fg-subtle">
                      {rule.bindHost || '127.0.0.1'}:{rule.bindPort || 0}
                      {rule.type === 'local' && rule.targetHost ? ` → ${rule.targetHost}:${rule.targetPort || 0}` : ''}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className={`text-[11px] ${running ? 'text-success' : runtime?.status === 'error' ? 'text-danger' : 'text-fg-subtle'}`}>
                        {running
                          ? translate('features.portForward.running', { count: String(runtime?.connections ?? 0) })
                          : runtime?.status === 'error'
                            ? runtime.error || translate('features.portForward.failed')
                            : translate('features.portForward.stopped')}
                      </span>
                      {running ? (
                        <button
                          type="button"
                          disabled={busyRuleId === rule.id}
                          onClick={() => { void runAction(rule.id, 'stop'); }}
                          className="toolbar-button px-2 py-1 text-xs"
                        >
                          <Square className="mr-1 h-3 w-3" />
                          {translate('features.portForward.stop')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busyRuleId === rule.id}
                          onClick={() => { void runAction(rule.id, 'start'); }}
                          className="toolbar-button-primary px-2 py-1 text-xs"
                        >
                          <Play className="mr-1 h-3 w-3" />
                          {translate('features.portForward.start')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
