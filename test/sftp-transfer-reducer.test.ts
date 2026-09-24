import { describe, expect, it } from 'vitest';

import type { SftpTransferTaskSnapshot } from '../src/shared/ipc-types';
import { upsertSftpTransferSnapshot } from '../src/renderer/transfer/sftp-transfer-reducer';

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

  it('does not replace a newer local state with an older same-sequence snapshot', () => {
    const current = task({ status: 'transferring', updatedAt: 102 });
    const stale = task({ status: 'waiting-conflict', updatedAt: 101 });

    expect(upsertSftpTransferSnapshot(current, stale)).toBe(current);
  });
});
