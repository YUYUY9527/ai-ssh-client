import { create } from 'zustand';

export type SftpTransferType = 'upload' | 'download';
export type SftpTransferStatus = 'pending' | 'transferring' | 'completed' | 'error';

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
  addTask: (task: SftpTransferTask) => void;
  markTransferring: (taskId: string) => void;
  updateProgress: (type: SftpTransferType, event: SftpTransferProgressEvent) => void;
  completeTask: (event: SftpTransferCompleteEvent) => void;
  removeTask: (taskId: string) => void;
}

const findTaskIndex = (
  tasks: SftpTransferTask[],
  type: SftpTransferType,
  event: Pick<SftpTransferProgressEvent, 'taskId' | 'filename' | 'connectionId'>,
) => tasks.findIndex((task) => {
  const isSameTask = event.taskId ? task.id === event.taskId : task.name === event.filename;
  return isSameTask && task.type === type && task.connectionId === event.connectionId;
});

/** Stores SFTP transfer state independently of the SFTP modal lifecycle. */
export const useSftpTransferStore = create<SftpTransferState>((set) => ({
  tasks: [],

  addTask: (task) => {
    set((state) => ({
      tasks: [...state.tasks.filter((item) => item.id !== task.id), task],
    }));
  },

  markTransferring: (taskId) => {
    set((state) => ({
      tasks: state.tasks.map((task) => (
        task.id === taskId ? { ...task, status: 'transferring' } : task
      )),
    }));
  },

  updateProgress: (type, event) => {
    set((state) => ({
      tasks: state.tasks.map((task) => {
        const isSameTask = event.taskId ? task.id === event.taskId : task.name === event.filename;
        if (
          isSameTask &&
          task.type === type &&
          task.connectionId === event.connectionId &&
          task.status === 'transferring'
        ) {
          return { ...task, progress: event.progress };
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
      tasks[taskIndex] = {
        ...task,
        progress: event.success ? 100 : task.progress,
        status: event.success ? 'completed' : 'error',
        error: event.error,
        localPath: event.localPath ?? task.localPath,
        remotePath: event.remotePath ?? task.remotePath,
      };

      return { tasks };
    });
  },

  removeTask: (taskId) => {
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== taskId),
    }));
  },
}));
