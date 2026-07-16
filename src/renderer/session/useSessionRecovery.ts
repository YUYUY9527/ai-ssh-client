import { useEffect, useRef } from 'react';

import type { AppSettings, SSHConnection } from '../../shared/types';
import { useConnectionStore } from '../store/useConnectionStore';
import { applyRemoteOutputBuffer } from './merge-remote-output';
import { loadSessionScrollbackSnapshots } from './session-scrollback';
import { useSessionStore } from './useSessionStore';

/** 重挂 live 会话：回放服务端输出缓冲并触发 resize。 */
async function reattachLiveSession(sessionId: string): Promise<void> {
  if (!window.electronAPI?.sshGetOutputBuffer) {
    return;
  }
  try {
    const bufferResult = await window.electronAPI.sshGetOutputBuffer(sessionId);
    if (bufferResult.success && bufferResult.data?.data) {
      applyRemoteOutputBuffer(sessionId, bufferResult.data.data);
    }
  } catch {
    // ignore
  }
  // 通知远端当前窗口尺寸（xterm 侧也会在 live 后 fit）
  try {
    await window.electronAPI.sshResize(sessionId, 120, 32);
  } catch {
    // ignore
  }
}

/** 为会话解析可用的连接配置（支持多会话克隆 id）。 */
function resolveConnectionForSession(
  sessionId: string,
  connectionId: string,
  connections: SSHConnection[],
): SSHConnection | null {
  const exact = connections.find((item) => item.id === sessionId || item.id === connectionId);
  if (!exact) {
    return null;
  }
  return exact.id === sessionId ? exact : { ...exact, id: sessionId };
}

/**
 * 启动时恢复滚动缓冲，并：
 * 1) 若后端仍有活动会话则直接重挂为 connected
 * 2) 否则在开启 autoReconnect 时自动重连
 */
export function useSessionRecovery(
  connections: SSHConnection[],
  settings: AppSettings,
): void {
  const recoveredRef = useRef(false);

  useEffect(() => {
    const snapshots = loadSessionScrollbackSnapshots();
    if (snapshots.length === 0) {
      return;
    }
    useSessionStore.getState().restoreSnapshots(snapshots, connections);
  }, [connections]);

  useEffect(() => {
    if (!window.electronAPI || connections.length === 0 || recoveredRef.current) {
      return;
    }
    recoveredRef.current = true;

    void (async () => {
      // 等一帧，确保 restoreSnapshots 已写入 store
      await Promise.resolve();

      const liveResult = await window.electronAPI?.sshGetSessions();
      const liveIds = new Set(
        liveResult?.success
          ? liveResult.data.sessions
            .filter((session) => session.isConnected)
            .map((session) => session.connectionId)
          : [],
      );

      const store = useSessionStore.getState();
      const sessionIds = [...store.orderedSessionIds];

      for (const sessionId of sessionIds) {
        const session = useSessionStore.getState().sessions[sessionId];
        if (!session) {
          continue;
        }

        // 后端会话仍在：直接恢复为在线，并回放缓冲（否则提示符已打过就丢了）
        if (liveIds.has(sessionId)) {
          useSessionStore.getState().setSessionState(sessionId, {
            state: 'connected',
            restoredFromScrollback: false,
            reconnectAttempts: 0,
            lastError: undefined,
          });
          await reattachLiveSession(sessionId);
          continue;
        }

        if (!settings.autoReconnect) {
          continue;
        }
        if (!session.restoredFromScrollback && session.state !== 'closed') {
          continue;
        }

        const connection = resolveConnectionForSession(
          sessionId,
          session.connectionId,
          connections,
        );
        if (!connection) {
          continue;
        }

        useSessionStore.getState().setSessionState(sessionId, {
          state: 'reconnecting',
          reconnectAttempts: Math.max(1, session.reconnectAttempts || 0),
        });

        const ok = await useConnectionStore.getState().connect(
          connection,
          undefined,
          undefined,
          settings,
        );

        useSessionStore.getState().setSessionState(sessionId, {
          state: ok ? 'connected' : 'closed',
          restoredFromScrollback: !ok,
          reconnectAttempts: ok ? 0 : (session.reconnectAttempts || 0) + 1,
          lastError: ok ? undefined : 'Reconnect failed',
        });
      }
    })();
  }, [connections, settings]);
}
