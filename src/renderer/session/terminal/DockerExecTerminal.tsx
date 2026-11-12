import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { getWebSftpClientId } from '../../lib/web';

interface DockerExecTerminalProps {
  connectionId: string;
  containerId: string;
  shell: string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onClose: () => void;
}

/**
 * 容器内交互式 shell：独立 WebSocket（/api/docker-exec）+ docker exec -it。
 * 与主终端会话完全隔离，关闭弹窗即断开。
 */
export function DockerExecTerminal({ connectionId, containerId, shell, translate, onClose }: DockerExecTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const styles = getComputedStyle(document.documentElement);
    const background = styles.getPropertyValue('--bg-primary').trim();
    const foreground = styles.getPropertyValue('--text-primary').trim();
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background, foreground },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;

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
          term.write(`\r\n\x1b[31m${message.payload?.message || 'error'}\x1b[0m\r\n`);
        } else if (message.type === 'docker-exec-exit') {
          term.write('\r\n\x1b[90m[container shell exited]\x1b[0m\r\n');
        }
      } catch {
        // 忽略非 JSON
      }
    };
    socket.onopen = () => {
      sendResize();
      term.focus();
      // 弹窗还在做进入动画时初次 fit 可能按旧尺寸算列宽，等布局稳定后再校一次。
      requestAnimationFrame(() => {
        try { fit.fit(); } catch { /* ignore */ }
        sendResize();
      });
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
      observer.disconnect();
      dataListener.dispose();
      resizeListener.dispose();
      try { socket.close(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
    };
  }, [connectionId, containerId, shell]);

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center overflow-y-auto p-4">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="industrial-modal relative my-auto flex h-[76vh] w-full max-w-5xl flex-col overflow-hidden">
        <div className="industrial-modal-header shrink-0">
          <span className="text-sm font-medium text-fg">
            {translate('terminal.docker.execTitle', { container: containerId.slice(0, 12), shell: shell || 'auto' })}
          </span>
          <button type="button" className="toolbar-button" onClick={onClose}>
            {translate('terminal.docker.close')}
          </button>
        </div>
        <div ref={hostRef} className="min-h-0 flex-1 bg-[var(--bg-primary)] p-2" />
      </div>
    </div>
  );
}
