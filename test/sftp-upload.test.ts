import { describe, it, expect } from 'vitest';
import { writeSftpFile } from '../server/sftp-upload.cjs';

describe('sftp-upload', () => {
  it('writes a file in chunks and reports progress', async () => {
    const buffer = Buffer.alloc(70 * 1024, 1);
    const handle = Buffer.from('handle');
    const writes: { offset: number; length: number; position: number; written: number }[] = [];
    const progress: { written: number; total: number }[] = [];
    let closed = false;
    await writeSftpFile({
      open(remotePath: string, flags: string, callback: Function) {
        expect(remotePath).toBe('/tmp/upload.txt');
        expect(flags).toBe('w');
        callback(null, handle);
      },
      write(receivedHandle: Buffer, data: Buffer, offset: number, length: number, position: number, callback: Function) {
        expect(receivedHandle).toBe(handle);
        expect(data).toBe(buffer);
        const written = Math.max(1, Math.floor(length / 2));
        writes.push({ offset, length, position, written });
        callback(null, offset + written);
      },
      close(receivedHandle: Buffer, callback: Function) {
        expect(receivedHandle).toBe(handle);
        closed = true;
        callback(null);
      },
    }, '/tmp/upload.txt', buffer, (written: number, total: number) => progress.push({ written, total }));

    expect(writes.length).toBeGreaterThan(1);
    expect(writes[0].offset).toBe(0);
    expect(writes[0].position).toBe(0);
    for (let index = 1; index < writes.length; index += 1) {
      expect(writes[index].offset).toBe(writes[index - 1].offset + writes[index - 1].written);
      expect(writes[index].position).toBe(writes[index].offset);
    }
    expect(progress.at(-1)!.written).toBe(buffer.length);
    expect(progress.at(-1)!.total).toBe(buffer.length);
    expect(closed).toBe(true);
  });

  it('closes the handle after a write failure', async () => {
    const handle = Buffer.from('handle');
    const buffer = Buffer.alloc(70 * 1024, 1);
    const failure = new Error('write failed');
    let closedAfterFailure = false;
    await expect(writeSftpFile({
      open(_remotePath: string, _flags: string, callback: Function) {
        callback(null, handle);
      },
      write(_handle: Buffer, _data: Buffer, _offset: number, _length: number, _position: number, callback: Function) {
        callback(failure);
      },
      close(_handle: Buffer, callback: Function) {
        closedAfterFailure = true;
        callback(null);
      },
    }, '/tmp/upload.txt', buffer)).rejects.toThrow(failure);
    expect(closedAfterFailure).toBe(true);
  });

  it('rejects an invalid write result', async () => {
    const handle = Buffer.from('handle');
    const buffer = Buffer.alloc(70 * 1024, 1);
    await expect(writeSftpFile({
      open(_remotePath: string, _flags: string, callback: Function) {
        callback(null, handle);
      },
      write(_handle: Buffer, _data: Buffer, offset: number, _length: number, _position: number, callback: Function) {
        callback(null, offset);
      },
      close(_handle: Buffer, callback: Function) {
        callback(null);
      },
    }, '/tmp/upload.txt', buffer)).rejects.toThrow(/Invalid SFTP write result/);
  });
});
