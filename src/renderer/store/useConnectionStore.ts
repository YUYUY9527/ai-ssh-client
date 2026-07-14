import { create } from 'zustand';
import type { AppSettings, SSHConnection } from '../../shared/types';

interface ConnectionState {
  connections: SSHConnection[];

  // 连接操作
  loadConnections: () => Promise<void>;
  saveConnection: (connection: SSHConnection) => Promise<void>;
  deleteConnection: (connectionId: string) => Promise<void>;
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
    const exact = connections.find((item) => item.id === connectionId);
    if (exact) {
      return get().connect(exact);
    }
    // 多会话克隆：id 为 `${baseId}-session-...`，用基础配置 + 会话 id 重连
    const base = connections.find((item) => connectionId.startsWith(`${item.id}-session-`));
    if (!base) return false;
    return get().connect({ ...base, id: connectionId });
  },
}));
