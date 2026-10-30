import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  buildDownloadEtag,
  readSftpFileEdges,
  EDGE_BYTES,
} from '../server/sftp-download-validator.cjs';

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 内存 SFTP：仅实现 createReadStream（支持 {start,end} 闭区间）。 */
function createFakeSftp(files: Map<string, Buffer>) {
  return {
    createReadStream(remotePath: string, options?: { start?: number; end?: number }) {
      const stream: any = new EventEmitter();
      stream.readable = true;
      queueMicrotask(() => {
        const data = files.get(remotePath);
        if (!data) {
          stream.emit('error', Object.assign(new Error('missing'), { code: 2 }));
          return;
        }
        const start = options?.start ?? 0;
        const end = options?.end ?? data.length - 1;
        stream.emit('data', data.subarray(start, end + 1));
        stream.emit('end');
      });
      return stream;
    },
  };
}

describe('buildDownloadEtag', () => {
  it('changes when the head hash changes even if size and mtime match', () => {
    const headA = 'a'.repeat(64);
    const headB = 'b'.repeat(64);
    const tail = 'c'.repeat(64);
    const first = buildDownloadEtag(1234, 1700000000, headA, tail);
    const second = buildDownloadEtag(1234, 1700000000, headB, tail);
    expect(first).not.toBe(second);
    expect(first).toContain(headA);
    expect(first).toContain(tail);
    expect(first).toContain('1234');
    expect(first.startsWith('"') && first.endsWith('"')).toBe(true);
  });

  it('is stable for identical inputs', () => {
    const head = 'd'.repeat(64);
    const tail = 'e'.repeat(64);
    expect(buildDownloadEtag(99, 12, head, tail)).toBe(buildDownloadEtag(99, 12, head, tail));
  });

  it('floors fractional mtime', () => {
    const head = 'f'.repeat(64);
    const tail = '0'.repeat(64);
    expect(buildDownloadEtag(10, 5.9, head, tail)).toBe(buildDownloadEtag(10, 5, head, tail));
  });

  it('returns empty when size<=0', () => {
    expect(buildDownloadEtag(0, 10, 'a'.repeat(64), 'b'.repeat(64))).toBe('');
    expect(buildDownloadEtag(-5, 10, 'a'.repeat(64), 'b'.repeat(64))).toBe('');
  });

  it('returns empty when any edge hash is missing', () => {
    expect(buildDownloadEtag(10, 10, '', 'b'.repeat(64))).toBe('');
    expect(buildDownloadEtag(10, 10, 'a'.repeat(64), '')).toBe('');
    expect(buildDownloadEtag(10, 10, undefined as unknown as string, undefined as unknown as string))
      .toBe('');
  });
});

describe('readSftpFileEdges', () => {
  it('returns empty edges for empty files', async () => {
    const edges = await readSftpFileEdges(createFakeSftp(new Map()), '/empty', 0);
    expect(edges).toEqual({ head: '', tail: '' });
  });

  it('hashes the whole file once when size <= EDGE_BYTES (head == tail)', async () => {
    const content = Buffer.from('hello world');
    const files = new Map([['/small.txt', content]]);
    const edges = await readSftpFileEdges(createFakeSftp(files), '/small.txt', content.length);
    expect(edges.head).toBe(sha256(content));
    expect(edges.tail).toBe(sha256(content));
  });

  it('hashes head and tail edges separately for large files', async () => {
    const content = Buffer.alloc(EDGE_BYTES + 10);
    for (let index = 0; index < content.length; index += 1) {
      content[index] = index % 251;
    }
    const files = new Map([['/big.bin', content]]);
    const edges = await readSftpFileEdges(createFakeSftp(files), '/big.bin', content.length);
    expect(edges.head).toBe(sha256(content.subarray(0, EDGE_BYTES)));
    expect(edges.tail).toBe(sha256(content.subarray(content.length - EDGE_BYTES)));
    expect(edges.head).not.toBe(edges.tail);
  });

  it('rejects when the stream errors', async () => {
    await expect(readSftpFileEdges(createFakeSftp(new Map()), '/missing', 10))
      .rejects.toThrow(/missing/);
  });
});
