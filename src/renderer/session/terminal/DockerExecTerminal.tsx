import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as TerminalIcon, X } from 'lucide-react';
import { getWebSftpClientId } from '../../lib/web';

interface DockerExecTerminalProps {
  connectionId: string;
  containerId: string;
  shell: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
  /** 是否限定在当前会话工作区内展示（不遮挡顶栏与会话标签栏）。 */
  scoped?: boolean;
}

function readExecTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const background = styles.getPropertyValue('--bg-primary').trim() || undefined;
  const foreground = styles.getPropertyValue('--text-primary').trim() || undefined;
  const accent = styles.getPropertyValue('--accent-primary').trim() || foreground;
  const isLight = document.documentElement.classList.contains('light');
  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: isLight ? 'rgba(15, 118, 110, 0.24)' : 'rgba(20, 184, 166, 0.3)',
  };
}

/**
 * 容器内交互式 shell：独立 WebSocket（/api/docker-exec）+ docker exec -it。
 * 与主终端会话完全隔离，关闭弹窗即断开。
 */
export function DockerExecTerminal({
  connectionId,
  containerId,
  shell,
  translate,
  onClose,
  scoped = false,
}: DockerExecTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [connState, setConnState] = useState<'connecting' | 'connected' | 'closed' | 'error'>('connecting');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    setConnState('connecting');
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: readExecTerminalTheme(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

    // 监听全局暗/亮主题切换，实时同步终端背景、文字与光标配色
    const themeObserver = new MutationObserver(() => {
      if (termRef.current) {
        termRef.current.options.theme = readExecTerminalTheme();
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({
      connectionId,
      containerId,
      shell,
      cols: String(term.cols),
      rows: String(term.rows),
      // 服务端用它把「新主机指纹确认」路由到本页面，缺了会直接拒绝新主机连接
      clientId: getWebSftpClientId(),
    });
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/docker-exec?${params.toString()}`);

    const sendResize = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'docker-exec-data') {
          term.write(message.payload?.data || '');
        } else if (message.type === 'docker-exec-error') {
          setConnState('error');
          term.write(`\r\n\x1b[31m${message.payload?.message || 'error'}\x1b[0m\r\n`);
        } else if (message.type === 'docker-exec-exit') {
          setConnState('closed');
          term.write('\r\n\x1b[90m[container shell exited]\x1b[0m\r\n');
        }
      } catch {
        // 忽略非 JSON
      }
    };
    socket.onopen = () => {
      setConnState('connected');
      sendResize();
      term.focus();
      // 弹窗还在做进入动画时初次 fit 可能按旧尺寸算列宽，等布局稳定后再校一次。
      requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* ignore */ }
        sendResize();
      });
    };
    socket.onerror = () => {
      setConnState('error');
    };
    socket.onclose = () => {
      setConnState((prev) => (prev === 'error' ? 'error' : 'closed'));
    };

    const dataListener = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    });
    const resizeListener = term.onResize(() => sendResize());

    const observer = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore */ }
    });
    observer.observe(host);

    return () => {
      themeObserver.disconnect();
      observer.disconnect();
      dataListener.dispose();
      resizeListener.dispose();
      try { socket.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
    };
  }, [connectionId, containerId, shell]);

  const wrapperClass = scoped
    ? 'pointer-events-auto absolute inset-0 z-overlay flex items-center justify-center overflow-y-auto p-4'
    : 'fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4';
  const panelHeightClass = scoped ? 'h-[min(90%,780px)] max-h-full' : 'h-[76vh]';
  const statusDotClass = connState === 'connected'
    ? 'status-dot-connected'
    : connState === 'connecting'
      ? 'status-dot-connecting'
      : connState === 'error'
        ? 'status-dot-error'
        : 'status-dot-idle';

  return (
    <div className={wrapperClass}>
      {/* 不在 backdrop 上绑定 onClose，避免误点遮罩直接杀掉运行中的容器交互 Shell */}
      <div className="modal-backdrop" />
      <div className={`industrial-modal relative my-auto flex ${panelHeightClass} w-full max-w-5xl flex-col overflow-hidden`}>
        <div className="industrial-modal-header shrink-0">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <TerminalIcon className="h-4 w-4 shrink-0 text-accent" />
            <span className={`status-dot ${statusDotClass}`} />
            <span
              className="min-w-0 truncate text-sm font-medium text-fg"
              title={translate('terminal.docker.execTitle', { container: containerId.slice(0, 12), shell: shell || 'auto' })}
            >
              {translate('terminal.docker.execTitle', { container: containerId.slice(0, 12), shell: shell || 'auto' })}
            </span>
          </div>
          <button
            type="button"
            className="icon-button shrink-0"
            onClick={onClose}
            title={translate('terminal.docker.close')}
            aria-label={translate('terminal.docker.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div ref={hostRef} className="min-h-0 flex-1 bg-[var(--bg-primary)] p-2" />
      </div>
    </div>
  );
}
