import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const [refreshing, setRefreshing] = useState(false);
  const [busyRuleId, setBusyRuleId] = useState<string | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const supported =
    typeof window !== 'undefined' && typeof window.electronAPI?.listPortForwards === 'function';

  const fetchForwards = useCallback(async () => {
    const api = window.electronAPI?.listPortForwards;
    if (!api || !connectionId) return;
    setRefreshing(true);
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
    } finally {
      setRefreshing(false);
    }
  }, [connectionId]);

  useEffect(() => {
    setOpen(false);
    setData(null);
    setError(null);
    setPanelPosition(null);
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

  // 点击外部 / Esc 收起
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

  // 通过 Portal 挂载在视口层并动态定位，避免被终端容器或窄分屏折叠工具栏裁切
  useLayoutEffect(() => {
    if (!open) return undefined;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = window.innerHeight;
      const margin = 12;
      const width = Math.max(0, Math.min(360, viewportWidth - margin * 2));
      const maxHeight = Math.max(0, Math.min(viewportHeight * 0.75, viewportHeight - margin * 2));
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
  }, [open, data, error]);

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
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className={`terminal-control ${open ? 'terminal-control-active' : ''}`}
        title={translate('features.portForward.title')}
        aria-label={translate('features.portForward.title')}
        aria-expanded={open}
      >
        <ArrowLeftRight className="h-4 w-4" />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          data-terminal-toolbar-popup="true"
          className="app-popover fixed left-3 top-3 z-overlay mt-0 max-h-[75vh] w-[360px] space-y-2.5 overflow-y-auto p-3 scrollbar-thin"
          style={{
            position: 'fixed',
            left: panelPosition?.left ?? 12,
            top: panelPosition?.top ?? 12,
            visibility: panelPosition ? 'visible' : 'hidden',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-fg">
              <ArrowLeftRight className="h-4 w-4 shrink-0 text-accent" />
              <span className="truncate">{translate('features.portForward.title')}</span>
            </span>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => { void fetchForwards(); }}
                disabled={refreshing}
                className="icon-button h-6 w-6"
                title={translate('features.portForward.refresh')}
                aria-label={translate('features.portForward.refresh')}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
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
            <p className="rounded-sm border border-[color-mix(in_srgb,var(--danger)_40%,var(--border-color))] bg-danger-muted px-2.5 py-1.5 text-[11px] text-danger-fg break-words">
              {error}
            </p>
          )}

          {rules.length === 0 ? (
            <p className="text-[11px] text-fg-muted">{translate('features.portForward.empty')}</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => {
                const runtime = activeFor(rule.id);
                const running = runtime?.status === 'running';
                const statusText = running
                  ? translate('features.portForward.running', { count: String(runtime?.connections ?? 0) })
                  : runtime?.status === 'error'
                    ? runtime.error || translate('features.portForward.failed')
                    : translate('features.portForward.stopped');
                return (
                  <div key={rule.id} className="space-y-1.5 rounded-lg border border-line-subtle bg-surface p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-xs font-medium text-fg" title={rule.label || rule.id}>
                        {rule.label || rule.id}
                      </span>
                      <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-fg-secondary">
                        {rule.type === 'dynamic' ? 'SOCKS5' : 'LOCAL'}
                      </span>
                    </div>
                    <div className="break-all font-mono text-[11px] text-fg-muted tabular-nums">
                      {rule.bindHost || '127.0.0.1'}:{running && runtime?.bindPort ? runtime.bindPort : rule.bindPort || 0}
                      {running && rule.bindPort === 0 ? <span className="ml-1 text-fg-subtle">{translate('features.portForward.autoPort')}</span> : null}
                      {rule.type === 'local' && rule.targetHost ? ` → ${rule.targetHost}:${rule.targetPort || 0}` : ''}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        title={statusText}
                        className={`min-w-0 flex-1 truncate text-[11px] ${
                          running ? 'text-success-fg' : runtime?.status === 'error' ? 'text-danger-fg' : 'text-fg-subtle'
                        }`}
                      >
                        {statusText}
                      </span>
                      {running ? (
                        <button
                          type="button"
                          disabled={busyRuleId === rule.id}
                          onClick={() => { void runAction(rule.id, 'stop'); }}
                          className="toolbar-button !h-7 shrink-0 px-2.5 text-xs"
                        >
                          <Square className="h-3 w-3 shrink-0" />
                          {translate('features.portForward.stop')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busyRuleId === rule.id}
                          onClick={() => { void runAction(rule.id, 'start'); }}
                          className="toolbar-button-primary !h-7 shrink-0 px-2.5 text-xs"
                        >
                          <Play className="h-3 w-3 shrink-0" />
                          {translate('features.portForward.start')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
