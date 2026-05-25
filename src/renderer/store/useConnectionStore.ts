import { create } from 'zustand';
import type { AppSettings, SSHConnection } from '../../shared/types';
import type { IPCResult } from '../../shared/ipc-types';

// 单个连接的终端输出最大保留字节数（约 100KB）。
// 保留更多切换标签后的恢复上下文，避免明显削弱终端历史体验。
const MAX_TERMINAL_OUTPUT_SIZE = 100 * 1024;

interface SessionState {
  isConnected: boolean;
  isConnecting: boolean;
  reconnectAttempts: number;
  lastError?: string;
}

interface ConnectionState {
  connections: SSHConnection[];
  activeConnectionId: string | null;
  terminalOutputs: Record<string, string>;
  sessionStates: Record<string, SessionState>;
  reconnectingId: string | null;

  // 连接操作
  loadConnections: () => Promise<void>;
  saveConnection: (connection: SSHConnection) => Promise<void>;
  deleteConnection: (connectionId: string) => Promise<void>;
  connect: (connection: SSHConnection, cols?: number, rows?: number, settings?: AppSettings) => Promise<boolean>;
  disconnect: (connectionId: string) => Promise<void>;
  reconnect: (connectionId: string) => Promise<boolean>;
  resize: (cols: number, rows: number) => void;
  setActiveConnection: (connectionId: string | null) => void;

  // 命令操作
  sendCommand: (command: string) => Promise<void>;
  executeCommand: (command: string) => Promise<IPCResult | undefined>;
  addTerminalOutput: (connectionId: string, data: string) => void;
  clearTerminalOutput: (connectionId: string) => void;

  // 状态更新
  updateSessionState: (connectionId: string, state: Partial<SessionState>) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  activeConnectionId: null,
  terminalOutputs: {},
  sessionStates: {},
  reconnectingId: null,

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
      const { activeConnectionId } = get();
      if (activeConnectionId === connectionId) {
        set({ activeConnectionId: null });
      }
      await get().loadConnections();
    }
  },

  connect: async (connection: SSHConnection, cols?: number, rows?: number, settings?: AppSettings) => {
    if (!window.electronAPI) return false;

    // 初始化会话状态
    set((state) => ({
      sessionStates: {
        ...state.sessionStates,
        [connection.id]: {
          isConnected: false,
          isConnecting: true,
          reconnectAttempts: 0,
        },
      },
    }));

    const result = await window.electronAPI.sshConnect(connection, cols, rows, settings);
    if (result.success) {
      set((state) => ({
        activeConnectionId: connection.id,
        reconnectingId: null,
        sessionStates: {
          ...state.sessionStates,
          [connection.id]: {
            ...state.sessionStates[connection.id],
            isConnected: true,
            isConnecting: false,
          },
        },
      }));
      return true;
    } else {
      set((state) => ({
        sessionStates: {
          ...state.sessionStates,
          [connection.id]: {
            ...state.sessionStates[connection.id],
            isConnecting: false,
            lastError: result.error,
          },
        },
      }));
      return false;
    }
  },

  disconnect: async (connectionId: string) => {
    if (!window.electronAPI) return;
    await window.electronAPI.sshDisconnect(connectionId);
    set((state) => {
      const newSessionStates = { ...state.sessionStates };
      if (newSessionStates[connectionId]) {
        newSessionStates[connectionId] = {
          ...newSessionStates[connectionId],
          isConnected: false,
          isConnecting: false,
        };
      }
      // 清理该连接的终端输出，释放内存
      const newTerminalOutputs = { ...state.terminalOutputs };
      delete newTerminalOutputs[connectionId];
      return {
        activeConnectionId: state.activeConnectionId === connectionId ? null : state.activeConnectionId,
        sessionStates: newSessionStates,
        terminalOutputs: newTerminalOutputs,
        reconnectingId: null,
      };
    });
  },

  reconnect: async (connectionId: string) => {
    if (!window.electronAPI) return false;
    const { connections } = get();
    const connection = connections.find(c => c.id === connectionId);
    if (!connection) return false;

    set({ reconnectingId: connectionId });
    const result = await get().connect(connection);
    if (!result) {
      set({ reconnectingId: null });
      return false;
    }
    return true;
  },

  setActiveConnection: (connectionId: string | null) => {
    set({ activeConnectionId: connectionId });
  },

  resize: (cols: number, rows: number) => {
    const { activeConnectionId } = get();
    if (activeConnectionId && window.electronAPI) {
      window.electronAPI.sshResize(activeConnectionId, cols, rows);
    }
  },

  sendCommand: async (command: string) => {
    if (!window.electronAPI) return;
    const { activeConnectionId } = get();
    if (activeConnectionId) {
      await window.electronAPI.sshExecute(activeConnectionId, command);
    }
  },

  executeCommand: async (command: string) => {
    if (!window.electronAPI) return;
    const { activeConnectionId } = get();
    if (activeConnectionId) {
      // 直接执行命令（不记录历史）
      return window.electronAPI.sshExecute(activeConnectionId, command + '\n');
    }
  },

  addTerminalOutput: (connectionId: string, data: string) => {
    if (!data) {
      return;
    }

    set((state) => {
      const currentOutput = state.terminalOutputs[connectionId] || '';
      let newOutput = currentOutput + data;

      // 滚动窗口：超过最大大小时截断旧数据，保留最新的 80%
      if (newOutput.length > MAX_TERMINAL_OUTPUT_SIZE) {
        const keepSize = Math.floor(MAX_TERMINAL_OUTPUT_SIZE * 0.8);
        newOutput = newOutput.slice(-keepSize);
      }

      if (newOutput === currentOutput) {
        return state;
      }

      return {
        terminalOutputs: {
          ...state.terminalOutputs,
          [connectionId]: newOutput,
        },
      };
    });
  },

  clearTerminalOutput: (connectionId: string) => {
    set((state) => ({
      terminalOutputs: {
        ...state.terminalOutputs,
        [connectionId]: '',
      },
    }));
  },

  updateSessionState: (connectionId: string, state: Partial<SessionState>) => {
    set((prev) => ({
      sessionStates: {
        ...prev.sessionStates,
        [connectionId]: {
          ...prev.sessionStates[connectionId],
          ...state,
        },
      },
    }));
  },
}));
