const { Readable } = require('node:stream');

/** 并行下载默认并发请求数。在途窗口 = 并发 × 块大小 = 1MiB，高延迟链路吞吐 ≈ 窗口/RTT。 */
const DEFAULT_CONCURRENCY = 32;
/** 单个 SFTP READ 请求的默认字节数。OpenSSH 通常支持 32 KiB，取小值避免被截断。 */
const DEFAULT_CHUNK_SIZE = 32 * 1024;

function openRemoteFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'r', (error, handle) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(handle);
    });
  });
}

function readAt(sftp, handle, position, length) {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.allocUnsafe(length);
    sftp.read(handle, buffer, 0, length, position, (error, bytesRead, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from((data || buffer).subarray(0, bytesRead)));
    });
  });
}

/**
 * 创建一个按顺序产出远端文件字节的 Readable 流。
 *
 * 与 ssh2 的 `createReadStream` 不同，这里会同时保持多个在途 SFTP READ 请求，
 * 按位置缓存结果并按顺序输出，从而把吞吐从“单请求/RTT”提升到“并发数×块大小/RTT”。
 *
 * @param {any} sftp ssh2 SFTP 会话
 * @param {string} remotePath 远端文件路径
 * @param {{ start?: number, end?: number, concurrency?: number, chunkSize?: number }} options
 *   `end` 为闭区间；不传表示读到文件末尾。
 * @returns {import('node:stream').Readable}
 */
function createPipelinedReadStream(sftp, remotePath, options = {}) {
  const start = Math.max(0, Number(options.start ?? 0));
  const end = options.end == null ? Number.POSITIVE_INFINITY : Number(options.end);
  const concurrency = Math.max(1, Math.floor(Number(options.concurrency) || DEFAULT_CONCURRENCY));
  const chunkSize = Math.max(1, Math.floor(Number(options.chunkSize) || DEFAULT_CHUNK_SIZE));

  const handlePromise = openRemoteFile(sftp, remotePath);
  let closed = false;
  let handle = null;
  let cancelRequested = false;
  let cancelGenerator = () => {};

  const closeHandle = async () => {
    if (closed) return;
    closed = true;
    try {
      const opened = await handlePromise;
      handle = opened;
      await new Promise((resolve) => {
        sftp.close(opened, () => resolve());
      });
    } catch {
      // 打开失败时没有句柄可关，错误由读流本身抛出。
    }
  };

  async function* generate() {
    handle = await handlePromise;
    const results = new Map();
    const waiters = [];
    let nextPosition = start;
    let expected = start;
    let inFlight = 0;
    let eof = false;
    let failure = null;
    let destroyed = cancelRequested;

    const wake = () => {
      const pending = waiters.splice(0);
      for (const resolve of pending) resolve();
    };
    const waitForWake = () => new Promise((resolve) => waiters.push(resolve));
    cancelGenerator = () => {
      destroyed = true;
      cancelRequested = true;
      wake();
    };
    if (destroyed) return;

    const enqueueRead = (position, length) => {
      inFlight += 1;
      readAt(sftp, handle, position, length)
        .then((buffer) => {
          inFlight -= 1;
          if (buffer.length > 0) results.set(position, buffer);
          if (buffer.length === 0) {
            eof = true;
          } else if (buffer.length < length && position + buffer.length <= end) {
            // 极少见的短读：补发缺口，避免顺序输出出现空洞。
            enqueueRead(position + buffer.length, length - buffer.length);
          }
          wake();
          schedule();
        })
        .catch((error) => {
          inFlight -= 1;
          failure = error;
          wake();
        });
    };

    const maybeDone = () => {
      if (inFlight === 0 && (eof || nextPosition > end)) wake();
    };

    const schedule = () => {
      while (!destroyed && !failure && !eof && inFlight < concurrency && nextPosition <= end) {
        const position = nextPosition;
        const length = Math.min(chunkSize, end - position + 1);
        nextPosition += length;
        enqueueRead(position, length);
      }
      maybeDone();
    };

    try {
      schedule();
      while (true) {
        if (destroyed) return;
        if (failure) throw failure;
        const buffer = results.get(expected);
        if (buffer) {
          results.delete(expected);
          expected += buffer.length;
          yield buffer;
          continue;
        }
        if (inFlight === 0 && (eof || nextPosition > end) && results.size === 0) {
          return;
        }
        await waitForWake();
      }
    } finally {
      await closeHandle();
    }
  }

  const stream = Readable.from(generate());
  stream.on('close', () => {
    // Readable.from 在消费者 destroy 时触发 close；唤醒生成器并关闭远端句柄。
    cancelRequested = true;
    cancelGenerator();
    closeHandle();
  });
  return stream;
}

module.exports = {
  DEFAULT_CONCURRENCY,
  DEFAULT_CHUNK_SIZE,
  createPipelinedReadStream,
};
