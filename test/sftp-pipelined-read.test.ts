import { describe, it, expect } from 'vitest';
import { createPipelinedReadStream } from '../server/sftp-pipelined-read.cjs';

function createFakeSftp(
  files: Map<string, Buffer>,
  options: { maxBytesPerRead?: number } = {},
) {
  const handles = new Map<number, string>();
  const closedHandles = new Set<number>();
  let nextHandle = 1;
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    get maxInFlight() {
      return maxInFlight;
    },
    get closedHandles() {
      return closedHandles;
    },
    open(remotePath: string, _flags: string, callback: (error: Error | null, handle?: number) => void) {
      setImmediate(() => {
        if (!files.has(remotePath)) {
          callback(Object.assign(new Error('missing'), { code: 2 }));
          return;
        }
        const handle = nextHandle++;
        handles.set(handle, remotePath);
        callback(null, handle);
      });
    },
    read(
      handle: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      callback: (error: Error | null, bytesRead?: number, data?: Buffer) => void,
    ) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setImmediate(() => {
        inFlight -= 1;
        const remotePath = handles.get(handle);
        const data = remotePath ? files.get(remotePath) : undefined;
        if (!data) {
          callback(Object.assign(new Error('missing'), { code: 2 }));
          return;
        }
        const effectiveLength = Math.min(length, options.maxBytesPerRead ?? length);
        const slice = data.subarray(position, Math.min(position + effectiveLength, data.length));
        slice.copy(buffer, offset);
        callback(null, slice.length, buffer);
      });
    },
    close(handle: number, callback: (error?: Error | null) => void) {
      closedHandles.add(handle);
      setImmediate(() => callback(null));
    },
  };
}

function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function makeContent(length: number): Buffer {
  const content = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) content[index] = index % 251;
  return content;
}

describe('createPipelinedReadStream', () => {
  it('reads a whole file in order with concurrent requests', async () => {
    const content = makeContent(4096);
    const sftp = createFakeSftp(new Map([['/file.bin', content]]));
    const stream = createPipelinedReadStream(sftp, '/file.bin', {
      concurrency: 4,
      chunkSize: 257,
    });
    const result = await collect(stream);
    expect(result.equals(content)).toBe(true);
    expect(sftp.maxInFlight).toBeGreaterThan(1);
  });

  it('honors start and end (inclusive) for range downloads', async () => {
    const content = makeContent(2048);
    const sftp = createFakeSftp(new Map([['/file.bin', content]]));
    const stream = createPipelinedReadStream(sftp, '/file.bin', {
      start: 13,
      end: 42,
      concurrency: 3,
      chunkSize: 7,
    });
    const result = await collect(stream);
    expect(result.equals(content.subarray(13, 43))).toBe(true);
  });

  it('fills short reads without leaving holes', async () => {
    const content = makeContent(1024);
    const sftp = createFakeSftp(new Map([['/file.bin', content]]), { maxBytesPerRead: 3 });
    const stream = createPipelinedReadStream(sftp, '/file.bin', {
      concurrency: 4,
      chunkSize: 64,
    });
    const result = await collect(stream);
    expect(result.equals(content)).toBe(true);
  });

  it('rejects when the remote file cannot be opened', async () => {
    const sftp = createFakeSftp(new Map());
    const stream = createPipelinedReadStream(sftp, '/missing.bin');
    await expect(collect(stream)).rejects.toThrow(/missing/);
  });

  it('closes the remote handle when the consumer destroys the stream', async () => {
    const content = makeContent(1024 * 1024);
    const sftp = createFakeSftp(new Map([['/file.bin', content]]));
    const stream = createPipelinedReadStream(sftp, '/file.bin', {
      concurrency: 2,
      chunkSize: 1024,
    });
    await new Promise<void>((resolve, reject) => {
      stream.once('data', () => {
        stream.destroy();
        resolve();
      });
      stream.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sftp.closedHandles.size).toBe(1);
  });
});
