import { create } from 'zustand';
import type { AppSettings, SSHConnection } from '../../shared/types';
import {
  buildRuntimeConnection,
  resolveSessionConnection,
} from '../session/resolve-session-connection';
import { useSessionStore } from '../session/useSessionStore';

interface ConnectionState {
  connections: SSHConnection[];

  // 连接操作
  loadConnections: () => Promise<void>;
  saveConnection: (connection: SSHConnection) => Promise<void>;
  deleteConnection: (connectionId: string) => Promise<void>;
  /** 按 id 顺序重排并持久化 */
  reorderConnections: (connectionIds: string[]) => Promise<void>;
  connect: (connection: SSHConnection, cols?: number, rows?: number, settings?: AppSettings) => Promise<boolean>;
  disconnect: (connectionId: string) => Promise<void>;
  reconnect: (connectionId: string) => Promise<boolean>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],

  loadConnections: async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.getConnections();
    if (result.success && result.data) {
      set({ connections: result.data.connections });
    }
  },

  saveConnection: async (connection: SSHConnection) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.saveConnection(connection);
    if (result.success) {
      await get().loadConnections();
    }
  },

  deleteConnection: async (connectionId: string) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.deleteConnection(connectionId);
    if (result.success) {
      await get().loadConnections();
    }
  },

  reorderConnections: async (connectionIds: string[]) => {
    if (!window.electronAPI) return;
    const current = get().connections;
    const byId = new Map(current.map((item) => [item.id, item]));
    // 先乐观更新 UI，失败再回读
    const ordered: SSHConnection[] = [];
    connectionIds.forEach((id) => {
      const item = byId.get(id);
      if (item) {
        ordered.push(item);
        byId.delete(id);
      }
    });
    byId.forEach((item) => ordered.push(item));
    set({ connections: ordered });

    const result = await window.electronAPI.reorderConnections(connectionIds);
    if (!result.success) {
      await get().loadConnections();
    }
  },

  connect: async (connection: SSHConnection, cols?: number, rows?: number, settings?: AppSettings) => {
    if (!window.electronAPI) return false;

    const result = await window.electronAPI.sshConnect(connection, cols, rows, settings);
    if (result.success) {
      return true;
    }

    return false;
  },

  disconnect: async (connectionId: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.sshDisconnect(connectionId);
  },

  reconnect: async (connectionId: string) => {
    if (!window.electronAPI) return false;
    const { connections } = get();
    const session = useSessionStore.getState().sessions[connectionId];
    // 临时会话不在连接列表：用 session.connectionId / `-session-` 前缀解析基础配置
    const base = resolveSessionConnection(
      connections,
      connectionId,
      session?.connectionId,
    );
    if (!base) return false;
    return get().connect(buildRuntimeConnection(base, connectionId, session?.title || base.name));
  },
}));
