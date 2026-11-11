'use strict';

const { StringDecoder } = require('node:string_decoder');

/**
 * 独立 exec 通道执行远端命令。
 *
 * 与 runSshCommand（Agent 用）不同：这里不复用交互式 shell，也不占用 activeAgentExecs
 * 单飞槽位，而是经 ssh2 Client.exec 新开一条 channel。用于监控采集、远程搜索等
 * “后台只读”操作——不会把命令回显进用户终端，也不会和 Agent 执行互相打断。
 *
 * client 为 ssh2 Client（或任何提供 .exec(command, cb) 的兼容对象，便于单测）。
 */

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MiB 输出上限，防 find/grep 刷屏撑爆内存

function execCommand(client, command, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let truncated = false;
    let timer = null;
    let channel = null;
    let streamError = null;
    const decoderOut = new StringDecoder('utf8');
    const decoderErr = new StringDecoder('utf8');

    const finish = (error, exitCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdout += decoderOut.end();
      stderr += decoderErr.end();
      if (error) {
        reject(error);
        return;
      }
      resolve({ output: stdout, stderr, exitCode: exitCode ?? 0, truncated });
    };

    try {
      client.exec(command, (error, stream) => {
        if (error) {
          finish(error);
          return;
        }
        channel = stream;
        stream.on('data', (data) => {
          if (stdoutBytes >= maxBytes) {
            truncated = true;
            return;
          }
          stdoutBytes += data.length;
          if (stdoutBytes > maxBytes) truncated = true;
          stdout += decoderOut.write(data);
        });
        if (stream.stderr && typeof stream.stderr.on === 'function') {
          stream.stderr.on('data', (data) => {
            stderr += decoderErr.write(data);
          });
        }
        stream.on('error', (err) => {
          streamError = err;
        });
        stream.on('close', (code) => finish(streamError, code));
      });
    } catch (error) {
      finish(error);
      return;
    }

    timer = setTimeout(() => {
      // 先以 timeout 结算，再关通道：否则 close 事件可能抢先以“正常结束”resolve。
      const error = new Error(`Remote command timed out after ${timeoutMs}ms`);
      error.code = 'timeout';
      finish(error);
      try {
        channel?.close?.();
      } catch {
        // 关闭失败不影响超时结算
      }
    }, timeoutMs);
    timer.unref?.();
  });
}

module.exports = { execCommand, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };