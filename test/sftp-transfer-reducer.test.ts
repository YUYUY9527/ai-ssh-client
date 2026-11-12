import { describe, expect, it } from 'vitest';

import type { SftpTransferTaskSnapshot } from '../src/shared/ipc-types';
import {
  canPauseSftpTransfer,
  canResumeSftpTransfer,
  upsertSftpTransferSnapshot,
} from '../src/renderer/transfer/sftp-transfer-reducer';

function task(overrides: Partial<SftpTransferTaskSnapshot> = {}): SftpTransferTaskSnapshot {
  return {
    taskId: 'task-1',
    connectionId: 'connection-1',
    attempt: 2,
    sequence: 2,
    direction: 'upload',
    status: 'transferring',
    name: 'same-name.md',
    remotePath: '/tmp/same-name.md',
    totalBytes: 100,
    transferredBytes: 0,
    resumedFrom: 0,
    progress: 0,
    conflictPolicy: 'ask',
    commitGuarantee: 'none',
    createdAt: 1,
    updatedAt: 100,
    ...overrides,
  };
}

describe('sftp transfer pause helpers', () => {
  it('canPause covers queued/checking/transferring/waiting-conflict only', () => {
    for (const status of ['queued', 'checking', 'transferring', 'waiting-conflict'] as const) {
      expect(canPauseSftpTransfer(task({ status }))).toBe(true);
    }
    for (const status of ['paused', 'committing', 'canceling', 'completed', 'failed', 'canceled'] as const) {
      expect(canPauseSftpTransfer(task({ status }))).toBe(false);
    }
  });

  it('canResume is true only for paused tasks', () => {
    expect(canResumeSftpTransfer(task({ status: 'paused' }))).toBe(true);
    for (const status of ['queued', 'transferring', 'completed', 'failed'] as const) {
      expect(canResumeSftpTransfer(task({ status }))).toBe(false);
    }
  });
});

describe('sftp transfer snapshot reducer', () => {
  it('accepts an authoritative conflict snapshot sharing the optimistic sequence', () => {
    const current = task({ status: 'transferring', updatedAt: 100 });
    const conflict = task({
      status: 'waiting-conflict',
      updatedAt: 101,
      conflict: {
        sourcePath: 'web-file:1',
        destinationPath: '/tmp/same-name.md',
        suggestedName: '/tmp/same-name (task-1).md',
      },
    });

    expect(upsertSftpTransferSnapshot(current, conflict)).toBe(conflict);
  });

  it('accepts a backend status change even when its timestamp is slightly older', () => {
    const current = task({ status: 'transferring', updatedAt: 102 });
    const conflict = task({ status: 'waiting-conflict', updatedAt: 101 });

    expect(upsertSftpTransferSnapshot(current, conflict)).toBe(conflict);
  });

  it('keeps an in-progress upload transferring across the between-chunk queued snapshot', () => {
    const current = task({ status: 'transferring', sequence: 4, transferredBytes: 40, progress: 40 });
    // 分片结束服务端短暂回到 queued（等待下一片），同一 attempt、更高 sequence。
    const betweenChunks = task({
      status: 'queued',
      sequence: 5,
      transferredBytes: 64,
      progress: 64,
      updatedAt: 120,
    });

    const next = upsertSftpTransferSnapshot(current, betweenChunks);
    expect(next.status).toBe('transferring');
    expect(next.transferredBytes).toBe(64);
    expect(next.progress).toBe(64);
    expect(next.sequence).toBe(5);
  });

  it('still shows queued when a retry opens a new attempt', () => {
    const current = task({ status: 'transferring', attempt: 2, sequence: 9, transferredBytes: 40 });
    const retried = task({ status: 'queued', attempt: 3, sequence: 0, transferredBytes: 40 });

    const next = upsertSftpTransferSnapshot(current, retried);
    expect(next.status).toBe('queued');
    expect(next.attempt).toBe(3);
  });

  it('does not shield a genuine first queued snapshot', () => {
    const queued = task({ status: 'queued', transferredBytes: 0 });
    expect(upsertSftpTransferSnapshot(undefined, queued)).toBe(queued);
  });

  it('still accepts a terminal transition from transferring', () => {
    const current = task({ status: 'transferring', sequence: 4 });
    const canceled = task({ status: 'canceled', sequence: 5, updatedAt: 120 });

    const next = upsertSftpTransferSnapshot(current, canceled);
    expect(next.status).toBe('canceled');
  });

  it('does not apply the upload anti-flicker rule to downloads', () => {
    const current = task({ direction: 'download', status: 'transferring', sequence: 4 });
    const queued = task({ direction: 'download', status: 'queued', sequence: 5, updatedAt: 120 });

    const next = upsertSftpTransferSnapshot(current, queued);
    expect(next.status).toBe('queued');
  });
});
