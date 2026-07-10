import { useCallback, useEffect, useRef } from 'react';

import type { AppSettings, SSHConnection } from '../../shared/types';
import { useConnectionStore } from '../store/useConnectionStore';
import { useSftpTransferStore } from '../store/useSftpTransferStore';
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
    const connection = connections.find((item) => item.id === sessionId);
    if (!session || !connection) {
      return;
    }

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

    const cleanupSftpUploadProgress = window.electronAPI.onSftpUploadProgress?.((data) => {
      useSftpTransferStore.getState().updateProgress('upload', data);
    });

    const cleanupSftpDownloadProgress = window.electronAPI.onSftpDownloadProgress?.((data) => {
      useSftpTransferStore.getState().updateProgress('download', data);
    });

    const cleanupSftpTransferComplete = window.electronAPI.onSftpTransferComplete?.((data) => {
      useSftpTransferStore.getState().completeTask(data);

      const transferLabel = data.transferType === 'upload'
        ? translate('fileTransfer.upload')
        : translate('fileTransfer.download');
      const title = data.success
        ? translate('fileTransfer.transferCompleted', { type: transferLabel })
        : translate('fileTransfer.transferFailed', { type: transferLabel });
      const body = data.success
        ? data.filename
        : `${data.filename}: ${data.error || translate('common.error')}`;

      onTransferToast?.({
        title,
        body,
        type: data.success ? 'success' : 'error',
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
      cleanupSftpUploadProgress?.();
      cleanupSftpDownloadProgress?.();
      cleanupSftpTransferComplete?.();
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
}
