import { useCallback, useEffect, useRef } from 'react';

import type { AppSettings, SSHConnection } from '../../shared/types';
import { useConnectionStore } from '../store/useConnectionStore';
import { useSftpTransferStore } from '../store/useSftpTransferStore';
import {
  buildRuntimeConnection,
  resolveSessionConnection,
} from './resolve-session-connection';
import { useSessionStore } from './useSessionStore';

interface UseSessionBridgeOptions {
  connections: SSHConnection[];
  settings: AppSettings;
  onTransferToast?: (toast: {
    title: string;
    body: string;
    type: 'success' | 'error';
  }) => void;
  onSessionStateChange?: (
    sessionId: string,
    state: { isConnected: boolean; isConnecting: boolean; reconnectAttempts: number; lastError?: string },
  ) => void;
  onSessionClosed?: (sessionId: string, isIntentional: boolean) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

/** Central SSH event bridge. All raw SSH events should flow through this hook. */
export function useSessionBridge(options: UseSessionBridgeOptions): void {
  const {
    connections,
    settings,
    onTransferToast,
    onSessionClosed,
    onSessionStateChange,
    translate,
  } = options;
  const outputBufferRef = useRef<Map<string, string[]>>(new Map());
  const flushHandleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // 同一任务终态可能同时来自 WebSocket 与 HTTP 本地快照，避免重复弹 toast
  const toastedTransferKeysRef = useRef<Set<string>>(new Set());
  // 回到页面时的会话校准节流：10s 内只跑一次，避免高频 focus 事件触发风暴
  const lastVisibilityRecoveryCheckRef = useRef(0);

  const flushOutput = useCallback(() => {
    flushHandleRef.current = null;
    const entries = Array.from(outputBufferRef.current.entries());
    outputBufferRef.current.clear();

    entries.forEach(([sessionId, chunks]) => {
      if (chunks.length === 0) {
        return;
      }

      const data = chunks.join('');
      useSessionStore.getState().appendOutput(sessionId, data);
    });
  }, []);

  const queueOutput = useCallback((sessionId: string, data: string) => {
    if (!data) {
      return;
    }

    const existing = outputBufferRef.current.get(sessionId);
    if (existing) {
      existing.push(data);
    } else {
      outputBufferRef.current.set(sessionId, [data]);
    }

    if (flushHandleRef.current == null) {
      flushHandleRef.current = setTimeout(flushOutput, 16);
    }
  }, [flushOutput]);

  const scheduleReconnect = useCallback((sessionId: string) => {
    if (!settings.autoReconnect || reconnectTimersRef.current.has(sessionId)) {
      return;
    }

    const session = useSessionStore.getState().sessions[sessionId];
    if (!session) {
      return;
    }
    // 临时会话不在列表：用 connectionId / `-session-` 解析已保存配置
    const baseConnection = resolveSessionConnection(
      connections,
      sessionId,
      session.connectionId,
    );
    if (!baseConnection) {
      return;
    }
    const connection = buildRuntimeConnection(
      baseConnection,
      sessionId,
      session.title || baseConnection.name,
    );

    const maxReconnectAttempts = settings.maxReconnectAttempts || 0;
    const reconnectAttempts = session.reconnectAttempts;
    if (maxReconnectAttempts > 0 && reconnectAttempts >= maxReconnectAttempts) {
      return;
    }

    useSessionStore.getState().setSessionState(sessionId, {
      state: 'reconnecting',
      reconnectAttempts: reconnectAttempts + 1,
    });

    const timer = setTimeout(async () => {
      reconnectTimersRef.current.delete(sessionId);
      const success = await useConnectionStore.getState().connect(
        connection,
        undefined,
        undefined,
        settings,
      );
      if (success) {
        useSessionStore.getState().setSessionState(sessionId, {
          state: 'connected',
          reconnectAttempts: 0,
          lastError: undefined,
          restoredFromScrollback: false,
        });
        return;
      }

      useSessionStore.getState().setSessionState(sessionId, {
        state: 'closed',
      });
      scheduleReconnect(sessionId);
    }, 1500);

    reconnectTimersRef.current.set(sessionId, timer);
  }, [connections, settings]);

  useEffect(() => {
    useSessionStore.getState().setPersistenceSettings({
      maxPersistedSessions: settings.maxPersistedSessions,
      maxScrollbackBytesPerSession: settings.maxScrollbackBytesPerSession,
    });
  }, [
    settings.maxPersistedSessions,
    settings.maxScrollbackBytesPerSession,
  ]);

  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    const cleanupSshData = window.electronAPI.onSshData(({ connectionId, data, type, state }) => {
      if (type === 'state' && state) {
        useSessionStore.getState().syncSessionStateFromSsh(connectionId, state);
        onSessionStateChange?.(connectionId, state);
        return;
      }

      if (data) {
        queueOutput(connectionId, data);
      }
    });

    const cleanupSshError = window.electronAPI.onSshError?.(({ connectionId, error }) => {
      queueOutput(connectionId, `\r\n\x1b[31mError: ${error}\x1b[0m\r\n`);
      useSessionStore.getState().setSessionState(connectionId, {
        state: 'error',
        lastError: error,
      });
    });

    const cleanupSshClose = window.electronAPI.onSshClose?.((connectionId) => {
      useSessionStore.getState().persistSessionOutput(connectionId);
      useSessionStore.getState().setSessionState(connectionId, {
        state: 'closed',
      });

      const isIntentional = useSessionStore.getState().consumeIntentionalDisconnect(connectionId);
      onSessionClosed?.(connectionId, isIntentional);

      if (isIntentional) {
        return;
      }

      scheduleReconnect(connectionId);
    });

    // 统一任务协议：事件进 store，终态弹出 toast。
    const cleanupSftpTransferEvent = window.electronAPI.onSftpTransferEvent?.((event) => {
      useSftpTransferStore.getState().applyTransferEvent(event);
      if (event.type !== 'terminal' && event.type !== 'snapshot') return;
      // snapshot 终态与 terminal 都通知，避免 Web FSA 只发 snapshot 时无 toast。
      const status = event.type === 'terminal'
        ? event.status
        : event.snapshot.status;
      if (!['completed', 'handed-off', 'skipped', 'failed', 'canceled', 'interrupted'].includes(status)) {
        return;
      }

      const task = event.type === 'snapshot'
        ? event.snapshot
        : useSftpTransferStore.getState().tasks.find((item) => item.taskId === event.taskId);
      const attempt = event.attempt ?? task?.attempt ?? 0;
      const toastKey = `${event.taskId}:${attempt}:${status}`;
      if (toastedTransferKeysRef.current.has(toastKey)) {
        return;
      }
      toastedTransferKeysRef.current.add(toastKey);
      // 防止集合无限增长：仅保留最近 200 条
      if (toastedTransferKeysRef.current.size > 200) {
        const first = toastedTransferKeysRef.current.values().next().value;
        if (first) toastedTransferKeysRef.current.delete(first);
      }

      const transferLabel = (task?.direction || 'upload') === 'upload'
        ? translate('fileTransfer.upload')
        : translate('fileTransfer.download');
      const success = status === 'completed' || status === 'handed-off' || status === 'skipped';
      const title = success
        ? translate('fileTransfer.transferCompleted', { type: transferLabel })
        : translate('fileTransfer.transferFailed', { type: transferLabel });
      const body = success
        ? (task?.name || event.taskId)
        : `${task?.name || event.taskId}: ${
          event.type === 'terminal'
            ? (event.error?.message || translate('common.error'))
            : (event.snapshot.error?.message || translate('common.error'))
        }`;

      onTransferToast?.({
        title,
        body,
        type: success ? 'success' : 'error',
      });
    });

    const cleanupSystemResume = window.electronAPI.onSystemResume?.(() => {
      if (resumeCheckTimeoutRef.current != null) {
        clearTimeout(resumeCheckTimeoutRef.current);
      }

      resumeCheckTimeoutRef.current = setTimeout(async () => {
        const result = await window.electronAPI?.sshGetSessions();
        if (!result?.success || !result.data?.sessions) {
          return;
        }

        const activeSessions = new Set(
          result.data.sessions.map((session) => session.connectionId),
        );

        useSessionStore.getState().orderedSessionIds.forEach((sessionId) => {
          const session = useSessionStore.getState().sessions[sessionId];
          if (session?.state === 'connected' && !activeSessions.has(sessionId)) {
            useSessionStore.getState().setSessionState(sessionId, { state: 'closed' });
            scheduleReconnect(sessionId);
          }
        });
      }, 2000);
    });

    return () => {
      if (flushHandleRef.current != null) {
        clearTimeout(flushHandleRef.current);
        flushHandleRef.current = null;
      }
      if (resumeCheckTimeoutRef.current != null) {
        clearTimeout(resumeCheckTimeoutRef.current);
        resumeCheckTimeoutRef.current = null;
      }
      reconnectTimersRef.current.forEach((timer) => clearTimeout(timer));
      reconnectTimersRef.current.clear();
      flushOutput();
      cleanupSshData();
      cleanupSshError?.();
      cleanupSshClose?.();
      cleanupSftpTransferEvent?.();
      cleanupSystemResume?.();
    };
  }, [
    connections,
    flushOutput,
    onTransferToast,
    onSessionClosed,
    onSessionStateChange,
    queueOutput,
    scheduleReconnect,
    settings,
    translate,
  ]);

  // 回到页面（标签页重新可见 / 窗口聚焦）时校准会话状态：
  // - 后台放置期间会话在服务端死亡，但 ssh-close 因 WS 断开而丢失 →
  //   前端 UI 仍显示"已连接"，实际输入全部失效 → 补发重连；
  // - 后台期间自动重连重试耗尽停在 closed → 重置计数重新来一轮。
  // 桌面端另有系统恢复事件校准，此处同时兜底 Web 端（节流 10s，防 focus 风暴）。
  useEffect(() => {
    if (!window.electronAPI) {
      return;
    }

    const runRecoveryCheck = () => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      const now = Date.now();
      if (now - lastVisibilityRecoveryCheckRef.current < 10000) {
        return;
      }
      lastVisibilityRecoveryCheckRef.current = now;

      void (async () => {
        const liveResult = await window.electronAPI?.sshGetSessions();
        const liveIds = new Set(
          liveResult?.success
            ? liveResult.data.sessions
              .filter((session) => session.isConnected)
              .map((session) => session.connectionId)
            : [],
        );

        const store = useSessionStore.getState();
        store.orderedSessionIds.forEach((sessionId) => {
          const session = store.sessions[sessionId];
          if (!session || !settings.autoReconnect) {
            return;
          }
          if (session.state === 'connected' && !liveIds.has(sessionId)) {
            // 服务端会话已丢但前端不知道：标记断开并自动重连
            store.setSessionState(sessionId, { state: 'closed', lastError: undefined });
            scheduleReconnect(sessionId);
            return;
          }
          if (session.state === 'closed' && (session.reconnectAttempts || 0) > 0) {
            // 之前自动重连耗尽失败：回到页面后重新开始一轮
            store.setSessionState(sessionId, { reconnectAttempts: 0 });
            scheduleReconnect(sessionId);
          }
        });
      })();
    };

    window.addEventListener('focus', runRecoveryCheck);
    document.addEventListener('visibilitychange', runRecoveryCheck);
    // 窗口已聚焦时点击页面不会触发 focus 事件；pointerdown 兜底"回到页面开始操作"的场景
    document.addEventListener('pointerdown', runRecoveryCheck);
    return () => {
      window.removeEventListener('focus', runRecoveryCheck);
      document.removeEventListener('visibilitychange', runRecoveryCheck);
      document.removeEventListener('pointerdown', runRecoveryCheck);
    };
  }, [scheduleReconnect, settings]);
}
