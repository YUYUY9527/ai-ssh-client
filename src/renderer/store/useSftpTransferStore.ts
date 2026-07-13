import { create } from 'zustand';

import {
  DEFAULT_REMOTE_PATH,
  type SftpBrowserSessionState,
  type TransferDirection,
  type TransferTaskStatus,
} from '../transfer/transfer-types';

export type SftpTransferType = TransferDirection;
export type SftpTransferStatus = TransferTaskStatus;

export interface SftpTransferTask {
  id: string;
  connectionId: string;
  name: string;
  type: SftpTransferType;
  progress: number;
  status: SftpTransferStatus;
  error?: string;
  localPath?: string;
  remotePath?: string;
  updatedAt: number;
}

export interface SftpTransferCompleteEvent {
  connectionId: string;
  taskId?: string;
  filename: string;
  transferType: SftpTransferType;
  success: boolean;
  error?: string;
  localPath?: string;
  remotePath?: string;
}

interface SftpTransferProgressEvent {
  connectionId: string;
  taskId?: string;
  filename: string;
  progress: number;
}

interface SftpTransferState {
  tasks: SftpTransferTask[];
  browserByConnection: Record<string, SftpBrowserSessionState>;
  addTask: (task: Omit<SftpTransferTask, 'updatedAt'> & { updatedAt?: number }) => void;
  markTransferring: (taskId: string) => void;
  updateProgress: (type: SftpTransferType, event: SftpTransferProgressEvent) => void;
  completeTask: (event: SftpTransferCompleteEvent) => void;
  removeTask: (taskId: string) => void;
  clearCompletedTasks: (connectionId?: string) => void;
  getBrowserState: (connectionId: string, preferredPath?: string) => SftpBrowserSessionState;
  setBrowserPath: (connectionId: string, remotePath: string) => void;
  setBrowserView: (connectionId: string, activeView: SftpBrowserSessionState['activeView']) => void;
  setBrowserSelection: (connectionId: string, selectedPath: string | null) => void;
  clearBrowserState: (connectionId: string) => void;
}

const DEFAULT_BROWSER_STATE: SftpBrowserSessionState = {
  remotePath: DEFAULT_REMOTE_PATH,
  activeView: 'files',
  selectedPath: null,
};

const findTaskIndex = (
  tasks: SftpTransferTask[],
  type: SftpTransferType,
  event: Pick<SftpTransferProgressEvent, 'taskId' | 'filename' | 'connectionId'>,
) => tasks.findIndex((task) => {
  const isSameTask = event.taskId ? task.id === event.taskId : task.name === event.filename;
  return isSameTask && task.type === type && task.connectionId === event.connectionId;
});

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

  addTask: (task) => {
    const nextTask: SftpTransferTask = {
      ...task,
      updatedAt: task.updatedAt ?? Date.now(),
    };
    set((state) => ({
      tasks: [...state.tasks.filter((item) => item.id !== nextTask.id), nextTask],
    }));
  },

  markTransferring: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (
        task.id === taskId
          ? { ...task, status: 'transferring', updatedAt: Date.now() }
          : task
      )),
    }));
  },

  updateProgress: (type, event) => {
    set((state) => ({
      tasks: state.tasks.map((task) => {
        const isSameTask = event.taskId ? task.id === event.taskId : task.name === event.filename;
        // 进度只增不减，避免客户端/服务端两段进度互相回退
        if (
          isSameTask
          && task.type === type
          && task.connectionId === event.connectionId
          && (task.status === 'pending' || task.status === 'transferring')
        ) {
          const nextProgress = Math.max(task.progress, Math.min(100, Math.max(0, event.progress)));
          if (nextProgress === task.progress && task.status === 'transferring') {
            return task;
          }
          return {
            ...task,
            status: 'transferring',
            progress: nextProgress,
            updatedAt: Date.now(),
          };
        }
        return task;
      }),
    }));
  },

  completeTask: (event) => {
    set((state) => {
      const taskIndex = findTaskIndex(state.tasks, event.transferType, event);
      if (taskIndex < 0) {
        return state;
      }

      const tasks = [...state.tasks];
      const task = tasks[taskIndex];
      // 已终态且成功完成时忽略重复失败/进度回写
      if (task.status === 'completed' && event.success) {
        return state;
      }
      if (task.status === 'completed' || task.status === 'error') {
        if (!event.success && task.status === 'error') {
          return state;
        }
        if (task.status === 'completed') {
          return state;
        }
      }

      tasks[taskIndex] = {
        ...task,
        progress: event.success ? 100 : task.progress,
        status: event.success ? 'completed' : 'error',
        error: event.error,
        localPath: event.localPath ?? task.localPath,
        remotePath: event.remotePath ?? task.remotePath,
        updatedAt: Date.now(),
      };

      return { tasks };
    });
  },

  removeTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== taskId),
    }));
  },

  clearCompletedTasks: (connectionId) => {
    set((state) => ({
      tasks: state.tasks.filter((task) => {
        if (connectionId && task.connectionId !== connectionId) {
          return true;
        }
        return task.status !== 'completed' && task.status !== 'error';
      }),
    }));
  },

  getBrowserState: (connectionId, preferredPath) => {
    const existing = get().browserByConnection[connectionId];
    if (existing) {
      return existing;
    }

    const created = ensureBrowserState({}, connectionId, preferredPath);
    set((state) => ({
      browserByConnection: {
        ...state.browserByConnection,
        [connectionId]: created,
      },
    }));
    return created;
  },

  setBrowserPath: (connectionId, remotePath) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: {
            ...current,
            remotePath,
            selectedPath: null,
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
          [connectionId]: {
            ...current,
            activeView,
          },
        },
      };
    });
  },

  setBrowserSelection: (connectionId, selectedPath) => {
    set((state) => {
      const current = ensureBrowserState(state.browserByConnection, connectionId);
      return {
        browserByConnection: {
          ...state.browserByConnection,
          [connectionId]: {
            ...current,
            selectedPath,
          },
        },
      };
    });
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
