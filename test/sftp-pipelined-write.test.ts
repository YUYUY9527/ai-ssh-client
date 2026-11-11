import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WRITE_CHUNK_SIZE,
  DEFAULT_WRITE_CONCURRENCY,
  writeAt,
  writePipelined,
} from '../server/sftp-pipelined-write.cjs';

function makeContent(length: number): Buffer {
  const content = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) content[index] = index % 251;
  return content;
}

function createFakeSftp(options: { maxBytesPerWrite?: number; failAt?: number } = {}) {
  const writes: { position: number; data: Buffer }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    get writes() {
      return writes;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    write(
      _handle: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      callback: (error: Error | null, acknowledged?: number) => void,
    ) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const effectiveLength = Math.min(length, options.maxBytesPerWrite ?? length);
      setImmediate(() => {
        inFlight -= 1;
        if (options.failAt !== undefined && position <= options.failAt && options.failAt < position + effectiveLength) {
          callback(new Error('remote write failed'));
          return;
        }
        writes.push({
          position,
          data: Buffer.from(buffer.subarray(offset, offset + effectiveLength)),
        });
        callback(null, offset + effectiveLength);
      });
    },
    render() {
      if (writes.length === 0) return Buffer.alloc(0);
      const end = Math.max(...writes.map((write) => write.position + write.data.length));
      const output = Buffer.alloc(end);
      for (const write of writes) write.data.copy(output, write.position);
      return output;
    },
  };
}

async function* sourceFrom(buffer: Buffer, frameSize = 1024): AsyncIterable<Buffer> {
  for (let start = 0; start < buffer.length; start += frameSize) {
    yield buffer.subarray(start, Math.min(start + frameSize, buffer.length));
  }
}

describe('writeAt', () => {
  it('fills short writes at the same remote position', async () => {
    const content = makeContent(1000);
    const sftp = createFakeSftp({ maxBytesPerWrite: 17 });
    await writeAt(sftp, 1, content, 0);
    expect(sftp.render().equals(content)).toBe(true);
  });
});

describe('writePipelined', () => {
  it('writes a whole source in order with concurrent requests', async () => {
    const content = makeContent(32 * 1024);
    const sftp = createFakeSftp();
    const acknowledgements: number[] = [];
    const result = await writePipelined(sftp, 1, sourceFrom(content, 3000), 0, {
      concurrency: 8,
      chunkSize: 777,
      onAck: (offset) => {
        acknowledgements.push(offset);
      },
    });
    expect(result.confirmedOffset).toBe(content.length);
    expect(result.bytesWritten).toBe(content.length);
    expect(sftp.render().equals(content)).toBe(true);
    expect(sftp.maxInFlight).toBeGreaterThan(1);
    expect(acknowledgements[acknowledgements.length - 1]).toBe(content.length);
    expect(acknowledgements).toEqual([...acknowledgements].sort((a, b) => a - b));
  });

  it('starts writing at the provided remote offset', async () => {
    const content = makeContent(4096);
    const sftp = createFakeSftp();
    await writePipelined(sftp, 1, sourceFrom(content.subarray(1234)), 1234, {
      concurrency: 4,
      chunkSize: 200,
    });
    const rendered = sftp.render();
    expect(rendered.length).toBe(content.length);
    expect(rendered.subarray(1234).equals(content.subarray(1234))).toBe(true);
    // 起始偏移之前的字节没有被写入（保持 0）。
    expect(rendered.subarray(0, 1234).equals(Buffer.alloc(1234))).toBe(true);
  });

  it('rejects on write failure only after in-flight writes settle', async () => {
    const content = makeContent(4096);
    const sftp = createFakeSftp({ failAt: 1500 });
    await expect(writePipelined(sftp, 1, sourceFrom(content), 0, {
      concurrency: 8,
      chunkSize: 256,
    })).rejects.toThrow(/remote write failed/);
    expect(sftp.maxInFlight).toBeGreaterThan(1);
  });

  it('stops launching new writes when canceled', async () => {
    const content = makeContent(64 * 1024);
    const sftp = createFakeSftp();
    let started = 0;
    await expect(writePipelined(sftp, 1, sourceFrom(content, 4096), 0, {
      concurrency: 4,
      chunkSize: 512,
      shouldCancel: () => started++ > 10,
    })).rejects.toMatchObject({ code: 'canceled' });
    expect(sftp.maxInFlight).toBeGreaterThan(1);
  });

  it('handles an empty source without issuing writes', async () => {
    const sftp = createFakeSftp();
    const result = await writePipelined(sftp, 1, sourceFrom(Buffer.alloc(0)), 0, {
      concurrency: 4,
      chunkSize: 64,
    });
    expect(result).toEqual({ startOffset: 0, confirmedOffset: 0, bytesWritten: 0 });
    expect(sftp.writes).toHaveLength(0);
  });

  it('writes a single-byte source', async () => {
    const content = Buffer.from('x');
    const sftp = createFakeSftp();
    const result = await writePipelined(sftp, 1, sourceFrom(content), 0, {
      concurrency: 4,
      chunkSize: 64,
    });
    expect(result.confirmedOffset).toBe(1);
    expect(result.bytesWritten).toBe(1);
    expect(sftp.render().equals(content)).toBe(true);
  });

  it('exposes documented defaults', () => {
    expect(DEFAULT_WRITE_CONCURRENCY).toBeGreaterThan(1);
    expect(DEFAULT_WRITE_CHUNK_SIZE).toBe(64 * 1024);
  });
});
