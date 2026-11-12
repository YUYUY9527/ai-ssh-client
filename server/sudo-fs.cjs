/**
 * sudo 文件访问（Web/Node 端）。
 *
 * SFTP 协议本身无法提权，这里改用 SSH exec 通道调用 sudo 完成受保护文件的读写：
 *   - 读：`sudo -- cat -- <path>`，stdout 即文件内容；
 *   - 写：`sudo -- tee -- <path>`，stdin 即完整内容。
 *
 * 密码策略：先 `sudo -n`（免密）尝试；失败时若调用方给了密码，再用 `sudo -S`
 * 把密码写在 stdin 第一行。密码只随请求传入、不落盘。
 */

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** POSIX shell 单引号转义，避免路径/内容被解释。 */
function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sudoError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function looksLikePasswordRequired(text) {
  return /a password is required|password is required|no tty present|a terminal is required|askpass|incorrect password attempt/i
    .test(String(text || ''));
}

/** 执行一条命令并收集输出。stdin 可选，触发后关闭写入。
 * stdout/stderr 以 Buffer 收集、结束时一次性解码，避免多字节字符被数据块边界劈开；
 * 传入 maxStdoutBytes 时超限立即中断，防止读大文件时内存无界增长。 */
function execCollect(client, command, { stdin, timeoutMs = 15000, maxStdoutBytes } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const stdoutChunks = [];
      const stderrChunks = [];
      let stdoutBytes = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { stream.close(); } catch { /* ignore */ }
        reject(sudoError('sudo command timed out', 'sudo-timeout'));
      }, timeoutMs);
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const stdoutBuffer = Buffer.concat(stdoutChunks);
        resolve({
          stdout: stdoutBuffer.toString('utf8'),
          // 原始字节留给需要严格校验的调用方（如 sudoReadTextFile）自行解码
          stdoutBuffer,
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          code,
        });
      };
      stream.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutChunks.push(buf);
        stdoutBytes += buf.length;
        if (typeof maxStdoutBytes === 'number' && stdoutBytes > maxStdoutBytes && !settled) {
          settled = true;
          clearTimeout(timer);
          try { stream.close(); } catch { /* ignore */ }
          reject(sudoError(`output exceeds ${maxStdoutBytes} bytes`, 'too-large'));
        }
      });
      stream.stderr.on('data', (chunk) => {
        stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('close', (code) => finish(typeof code === 'number' ? code : 0));
      stream.on('error', (streamError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(streamError);
      });
      if (typeof stdin === 'string') {
        stream.end(stdin);
      } else {
        stream.end();
      }
    });
  });
}

async function runSudo(client, baseCommand, { password, stdinBody, maxStdoutBytes } = {}) {
  // 1) 免密尝试
  const nonInteractive = await execCollect(client, `sudo -n -- ${baseCommand}`, { stdin: stdinBody, maxStdoutBytes });
  if (nonInteractive.code === 0) return nonInteractive;
  const passwordRequired = looksLikePasswordRequired(nonInteractive.stderr);
  if (!passwordRequired) {
    throw sudoError(
      `sudo failed: ${(nonInteractive.stderr || nonInteractive.stdout || '').trim() || `exit code ${nonInteractive.code}`}`,
      'sudo-failed',
    );
  }
  if (!password) {
    throw sudoError('SUDO_PASSWORD_REQUIRED', 'sudo-password-required');
  }
  // 2) 带密码：密码写在 stdin 第一行
  const payload = stdinBody === undefined ? `${password}\n` : `${password}\n${stdinBody}`;
  const authenticated = await execCollect(client, `sudo -S -p '' -- ${baseCommand}`, { stdin: payload, maxStdoutBytes });
  if (authenticated.code !== 0) {
    const reason = (authenticated.stderr || '').trim();
    if (looksLikePasswordRequired(reason) || /incorrect password/i.test(reason)) {
      throw sudoError('SUDO_PASSWORD_INCORRECT', 'sudo-password-incorrect');
    }
    throw sudoError(`sudo failed: ${reason || `exit code ${authenticated.code}`}`, 'sudo-failed');
  }
  return authenticated;
}

/** 用 sudo 读取远端文本文件。maxBytes 同时作为收集上限：超限立即中断命令，而不是等读完全部输出。 */
async function sudoReadTextFile(client, remotePath, { password, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!client) throw sudoError('SSH session is not connected', 'no-session');
  const result = await runSudo(client, `cat -- ${quoteShellArg(remotePath)}`, {
    password,
    maxStdoutBytes: maxBytes + 1,
  });
  // 严格 UTF-8 解码：与普通 SFTP 文本读取（sftp-items.cjs）保持同一语义——
  // 非法字节直接报错而不是静默替换成 U+FFFD，避免用户保存后损坏原文件。
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdoutBuffer);
  } catch {
    throw sudoError('File is not valid UTF-8 text and cannot be edited in-app', 'unsupported-encoding');
  }
  if (content.includes('\u0000')) {
    throw sudoError('File is not valid UTF-8 text and cannot be edited in-app', 'unsupported-encoding');
  }
  const size = Buffer.byteLength(content, 'utf8');
  if (size > maxBytes) {
    throw sudoError(`File is too large to edit (${size} bytes, max ${maxBytes} bytes)`, 'too-large');
  }
  return { content, size, maxBytes };
}

/** 用 sudo 覆盖写入远端文本文件。 */
async function sudoWriteTextFile(client, remotePath, content, { password } = {}) {
  if (!client) throw sudoError('SSH session is not connected', 'no-session');
  await runSudo(client, `tee -- ${quoteShellArg(remotePath)}`, { password, stdinBody: String(content ?? '') });
  return true;
}

module.exports = {
  quoteShellArg,
  looksLikePasswordRequired,
  execCollect,
  sudoReadTextFile,
  sudoWriteTextFile,
  DEFAULT_MAX_BYTES,
};
