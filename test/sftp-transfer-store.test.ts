import { beforeEach, describe, expect, it } from 'vitest';

import type { SftpTransferTaskSnapshot } from '../src/shared/ipc-types';
import { useSftpTransferStore } from '../src/renderer/store/useSftpTransferStore';

function task(overrides: Partial<SftpTransferTaskSnapshot> = {}): SftpTransferTaskSnapshot {
  return {
    taskId: 'task-1',
    connectionId: 'connection-1',
    attempt: 1,
    sequence: 1,
    direction: 'upload',
    status: 'transferring',
    name: 'report.pdf',
    remotePath: '/tmp/report.pdf',
    totalBytes: 100,
    transferredBytes: 10,
    resumedFrom: 0,
    progress: 10,
    conflictPolicy: 'ask',
    commitGuarantee: 'none',
    createdAt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

function tasks(): SftpTransferTaskSnapshot[] {
  return useSftpTransferStore.getState().tasks;
}

describe('sftp transfer store syncSnapshots (对账)', () => {
  beforeEach(() => {
    useSftpTransferStore.setState({ tasks: [] });
  });

  it('不会复活本地未跟踪的历史任务（含已完成），避免刷新后已清理记录回魂', () => {
    // 刷新后 store 为空；服务端列表里还留着旧的已完成上传。
    useSftpTransferStore.getState().syncSnapshots([
      task({ taskId: 'old-done', status: 'completed', sequence: 9, completedAt: 200 }),
      task({ taskId: 'old-active', status: 'transferring' }),
    ]);

    expect(tasks()).toHaveLength(0);
  });

  it('更新本地已跟踪的任务状态（例如断线期间完成）', () => {
    useSftpTransferStore.setState({ tasks: [task({ status: 'transferring', sequence: 3 })] });

    useSftpTransferStore.getState().syncSnapshots([
      task({ status: 'completed', sequence: 4, transferredBytes: 100, progress: 100, completedAt: 150 }),
    ]);

    expect(tasks()).toHaveLength(1);
    expect(tasks()[0].status).toBe('completed');
    expect(tasks()[0].transferredBytes).toBe(100);
  });

  it('忽略比本地更旧的服务端快照，不回退进度', () => {
    useSftpTransferStore.setState({
      tasks: [task({ status: 'transferring', sequence: 5, transferredBytes: 60, progress: 60 })],
    });

    useSftpTransferStore.getState().syncSnapshots([
      task({ status: 'transferring', sequence: 2, transferredBytes: 20, progress: 20 }),
    ]);

    expect(tasks()[0].sequence).toBe(5);
    expect(tasks()[0].transferredBytes).toBe(60);
  });

  it('同一列表里同时更新已知任务、跳过未知任务', () => {
    useSftpTransferStore.setState({ tasks: [task({ taskId: 'known', status: 'transferring', sequence: 1 })] });

    useSftpTransferStore.getState().syncSnapshots([
      task({ taskId: 'known', status: 'completed', sequence: 2, completedAt: 120 }),
      task({ taskId: 'unknown', status: 'completed', sequence: 1, completedAt: 120 }),
    ]);

    expect(tasks().map((item) => item.taskId)).toEqual(['known']);
    expect(tasks()[0].status).toBe('completed');
  });
});
