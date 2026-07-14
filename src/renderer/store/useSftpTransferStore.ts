import { create } from 'zustand';

import type {
  SftpTransferEvent,
  SftpTransferTaskSnapshot,
} from '../../shared/ipc-types';
import {
  DEFAULT_REMOTE_PATH,
  type SftpBrowserSessionState,
  type TransferDirection,
  type TransferTaskStatus,
} from '../transfer/transfer-types';
import {
  applySftpTransferEvent as reduceTransferEvent,
  isSftpTransferTerminal,
  upsertSftpTransferSnapshot,
} from '../transfer/sftp-transfer-reducer';

export type SftpTransferType = TransferDirection;
export type SftpTransferStatus = TransferTaskStatus;
export type SftpTransferTask = SftpTransferTaskSnapshot;

interface SftpTransferState {
  tasks: SftpTransferTaskSnapshot[];
  browserByConnection: Record<string, SftpBrowserSessionState>;
  upsertSnapshot: (snapshot: SftpTransferTaskSnapshot) => void;
  applyTransferEvent: (event: SftpTransferEvent) => void;
  removeTask: (taskId: string) => void;
  clearCompletedTasks: (connectionId?: string) => void;
  getBrowserState: (connectionId: string, preferredPath?: string) => SftpBrowserSessionState;
  setBrowserPath: (connectionId: string, remotePath: string) => void;
  requestBrowserPath: (connectionId: string, remotePath: string) => void;
  setBrowserView: (connectionId: string, activeView: SftpBrowserSessionState['activeView']) => void;
  setBrowserSelectedPaths: (connectionId: string, selectedPaths: string[], selectionAnchorPath?: string | null) => void;
  toggleBrowserSelection: (connectionId: string, path: string) => void;
  extendBrowserSelection: (connectionId: string, orderedPaths: string[], path: string) => void;
  clearBrowserSelection: (connectionId: string) => void;
  setBrowserSelection: (connectionId: string, selectedPath: string | null) => void;
  clearBrowserState: (connectionId: string) => void;
}

const DEFAULT_BROWSER_STATE: SftpBrowserSessionState = {
  remotePath: DEFAULT_REMOTE_PATH,
  activeView: 'files',
  selectedPaths: [],
  selectionAnchorPath: null,
  navigationVersion: 0,
};

/** 获取连接对应的浏览状态，缺失时返回默认状态。 */
function ensureBrowserState(
  browserByConnection: Record<string, SftpBrowserSessionState>,
  connectionId: string,
  preferredPath?: string,
): SftpBrowserSessionState {
  const existing = browserByConnection[connectionId];
  if (existing) {
    return existing;
  }
  return {
    ...DEFAULT_BROWSER_STATE,
    remotePath: preferredPath || DEFAULT_REMOTE_PATH,
  };
}

/** Stores SFTP transfer and per-session browser state independently of sidebar lifecycle. */
export const useSftpTransferStore = create<SftpTransferState>((set, get) => ({
  tasks: [],
  browserByConnection: {},

  upsertSnapshot: (snapshot) => {
    set((state) => {
      const index = state.tasks.findIndex((task) => task.taskId === snapshot.taskId);
      if (index < 0) {
        return { tasks: [...state.tasks, snapshot] };
      }
      const current = state.tasks[index];
      const next = upsertSftpTransferSnapshot(current, snapshot);
      if (next === current) {
        return state;
      }
      const tasks = [...state.tasks];
      tasks[index] = next;
      return { tasks };
    });
  },

  applyTransferEvent: (event) => {
    set((state) => {
      const index = state.tasks.findIndex((task) => task.taskId === event.taskId);
      const current = index >= 0 ? state.tasks[index] : undefined;
      const next = reduceTransferEvent(current, event);
      if (!next || next === current) {
        return state;
      }
      if (index < 0) {
        return { tasks: [...state.tasks, next] };
      }
      const tasks = [...state.tasks];
      tasks[index] = next;
      return { tasks };
    });
  },

  removeTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.filter((task) => (
        task.taskId !== taskId || !isSftpTransferTerminal(task.status)
      )),
    }));
  },

  clearCompletedTasks: (connectionId) => {
    set((state) => ({
      tasks: state.tasks.filter((task) => (
        (connectionId && task.connectionId !== connectionId)
        || !isSftpTransferTerminal(task.status)
      )),
    }));
  },

  getBrowserState: (connectionId, preferredPath) => {
    const existing = get().browserByConnection[connectionId];
    if (existing) {
      return existing;
    }
    const created = ensureBrowserState({}, connectionId, preferredPath);
    set((state) => ({
      browserByConnection: { ...state.browserByConnection, [connectionId]: created },
    }));
    return created;
  },

  setBrowserPath: (connectionId, remotePath) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      // 仅导航到新路径时清空选择；同路径刷新由调用方剔除失效项。
      const pathChanged = current.remotePath !== remotePath;
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: {
            ...current,
            remotePath,
            selectedPaths: pathChanged ? [] : current.selectedPaths,
            selectionAnchorPath: pathChanged ? null : current.selectionAnchorPath,
          },
        },
      };
    });
  },

  requestBrowserPath: (connectionId, remotePath) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: {
            ...current,
            remotePath,
            activeView: 'files',
            selectedPaths: [],
            selectionAnchorPath: null,
            navigationVersion: current.navigationVersion + 1,
          },
        },
      };
    });
  },

  setBrowserView: (connectionId, activeView) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: { ...current, activeView },
        },
      };
    });
  },

  setBrowserSelectedPaths: (connectionId, selectedPaths, selectionAnchorPath) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      // 去重并保持调用方提供的显示顺序。
      const uniquePaths = [...new Set(selectedPaths)];
      const anchor = selectionAnchorPath === undefined
        ? (uniquePaths[uniquePaths.length - 1] ?? null)
        : selectionAnchorPath;
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: {
            ...current,
            selectedPaths: uniquePaths,
            selectionAnchorPath: anchor,
          },
        },
      };
    });
  },

  toggleBrowserSelection: (connectionId, path) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      const selected = current.selectedPaths.includes(path);
      const selectedPaths = selected
        ? current.selectedPaths.filter((item) => item !== path)
        : [...current.selectedPaths, path];
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: {
            ...current,
            selectedPaths,
            selectionAnchorPath: selected && current.selectionAnchorPath === path
              ? (selectedPaths[selectedPaths.length - 1] ?? null)
              : path,
          },
        },
      };
    });
  },

  extendBrowserSelection: (connectionId, orderedPaths, path) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      const anchor = current.selectionAnchorPath;
      const anchorIndex = anchor ? orderedPaths.indexOf(anchor) : -1;
      const targetIndex = orderedPaths.indexOf(path);
      const selectedPaths = anchorIndex >= 0 && targetIndex >= 0
        ? orderedPaths.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
        : [path];
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: {
            ...current,
            selectedPaths,
            selectionAnchorPath: anchorIndex >= 0 ? anchor : path,
          },
        },
      };
    });
  },

  clearBrowserSelection: (connectionId) => {
    get().setBrowserSelectedPaths(connectionId, [], null);
  },

  setBrowserSelection: (connectionId, selectedPath) => {
    // 单选兼容入口同步写入新的多选字段。
    get().setBrowserSelectedPaths(connectionId, selectedPath ? [selectedPath] : [], selectedPath);
  },

  clearBrowserState: (connectionId) => {
    set((state) => {
      if (!state.browserByConnection[connectionId]) {
        return state;
      }
      const next = { ...state.browserByConnection };
      delete next[connectionId];
      return { browserByConnection: next };
    });
  },
}));
