// 在途窗口 = 并发 × 块大小 = 2MiB。吞吐上限 ≈ 在途字节/RTT，高延迟链路需要
// 足够大的窗口；ssh2 通道窗口约 2MiB，再大收益也被通道层封顶。
const DEFAULT_WRITE_CONCURRENCY = 32;
const DEFAULT_WRITE_CHUNK_SIZE = 64 * 1024;

/**
 * 写单个块到指定远端偏移。
 *
 * ssh2 的 WRITE 回调第二个参数是 bufferOffset + bytesWritten，不是文件绝对偏移；
 * 这里显式传入 bufferOffset，因此用 `acknowledged - bufferOffset` 得到本次真正写入
 * 的字节数。服务端返回短写时继续从剩余位置补写，避免把不完整块当成成功。
 */
function writeAt(sftp, handle, buffer, position) {
  return new Promise((resolve, reject) => {
    let bufferOffset = 0;
    const send = () => {
      const remaining = buffer.length - bufferOffset;
      if (remaining === 0) {
        resolve(buffer.length);
        return;
      }
      sftp.write(handle, buffer, bufferOffset, remaining, position + bufferOffset, (error, acknowledged) => {
        if (error) {
          reject(error);
          return;
        }
        const written = Number(acknowledged) - bufferOffset;
        if (!Number.isInteger(written) || written <= 0 || written > remaining) {
          reject(new Error(`Invalid SFTP write result: ${acknowledged}`));
          return;
        }
        bufferOffset += written;
        send();
      });
    };
    send();
  });
}

/**
 * 并发流水写远端文件。
 *
 * 一次只保留最多 concurrency 个 SFTP WRITE 在途；confirmedOffset 严格按提交顺序
 * 推进，只有连续的前序块都确认后才算已确认。这样进度、checkpoint 和续传 offset
 * 永远不会越过真实落盘范围。失败/取消时先等待所有在途写 settle（成功或失败），
 * 再把错误抛出，调用方才能安全关闭 handle 并落最终 checkpoint。
 *
 * @param {object} sftp ssh2 SFTP 实例
 * @param {object|number} handle 已打开的远端文件句柄
 * @param {AsyncIterable<Buffer|string>} source 请求体等异步字节源
 * @param {number} startOffset 本次写入的起始远端偏移
 * @param {{concurrency?: number, chunkSize?: number, shouldCancel?: () => boolean, onAck?: (offset: number, length: number) => (void|Promise<void>)}} [options]
 * @returns {Promise<{startOffset: number, confirmedOffset: number, bytesWritten: number}>}
 */
async function writePipelined(sftp, handle, source, startOffset, options = {}) {
  const concurrency = Math.max(1, Number(options.concurrency) || DEFAULT_WRITE_CONCURRENCY);
  const chunkSize = Math.max(1, Number(options.chunkSize) || DEFAULT_WRITE_CHUNK_SIZE);
  const shouldCancel = options.shouldCancel || (() => false);
  const onAck = options.onAck || (() => undefined);

  let nextPosition = startOffset;
  let confirmedOffset = startOffset;
  const pending = [];

  const drainHead = async () => {
    const entry = pending[0];
    if (!entry) return;
    await entry.promise;
    pending.shift();
    confirmedOffset = entry.position + entry.length;
    await onAck(confirmedOffset, entry.length);
  };

  const waitForSlot = async () => {
    while (pending.length >= concurrency) {
      await drainHead();
    }
  };

  const throwIfCanceled = () => {
    if (shouldCancel()) {
      const error = new Error('Transfer canceled');
      error.code = 'canceled';
      throw error;
    }
  };

  try {
    for await (const input of source) {
      throwIfCanceled();
      const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
      for (let start = 0; start < chunk.length; start += chunkSize) {
        await waitForSlot();
        throwIfCanceled();
        const part = chunk.subarray(start, Math.min(start + chunkSize, chunk.length));
        const position = nextPosition;
        nextPosition += part.length;
        let resolveWrite;
        let rejectWrite;
        const promise = new Promise((resolve, reject) => {
          resolveWrite = resolve;
          rejectWrite = reject;
        });
        pending.push({ position, length: part.length, promise });
        writeAt(sftp, handle, part, position).then(resolveWrite, rejectWrite);
      }
    }
    while (pending.length > 0) {
      await drainHead();
    }
    return {
      startOffset,
      confirmedOffset,
      bytesWritten: confirmedOffset - startOffset,
    };
  } catch (error) {
    // 不能让调用方在仍有 WRITE 在途时关闭句柄或删除远端文件：先等所有在途写
    // 成功或失败。confirmedOffset 只停留在连续确认的位置，供上层安全续传。
    const settled = await Promise.allSettled(pending.map((entry) => entry.promise));
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index];
      if (entry.position !== confirmedOffset || settled[index].status !== 'fulfilled') break;
      confirmedOffset = entry.position + entry.length;
    }
    if (error && typeof error === 'object' && !('confirmedOffset' in error)) {
      error.confirmedOffset = confirmedOffset;
    }
    throw error;
  }
}

module.exports = {
  DEFAULT_WRITE_CONCURRENCY,
  DEFAULT_WRITE_CHUNK_SIZE,
  writeAt,
  writePipelined,
};
