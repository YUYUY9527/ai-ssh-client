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

/** 执行一条命令并收集输出。stdin 可选，触发后关闭写入。 */
function execCollect(client, command, { stdin, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
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
        resolve({ stdout, stderr, code });
      };
      stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
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

async function runSudo(client, baseCommand, { password, stdinBody } = {}) {
  // 1) 免密尝试
  const nonInteractive = await execCollect(client, `sudo -n -- ${baseCommand}`, { stdin: stdinBody });
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
  const authenticated = await execCollect(client, `sudo -S -p '' -- ${baseCommand}`, { stdin: payload });
  if (authenticated.code !== 0) {
    const reason = (authenticated.stderr || '').trim();
    if (looksLikePasswordRequired(reason) || /incorrect password/i.test(reason)) {
      throw sudoError('SUDO_PASSWORD_INCORRECT', 'sudo-password-incorrect');
    }
    throw sudoError(`sudo failed: ${reason || `exit code ${authenticated.code}`}`, 'sudo-failed');
  }
  return authenticated;
}

/** 用 sudo 读取远端文本文件。 */
async function sudoReadTextFile(client, remotePath, { password, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!client) throw sudoError('SSH session is not connected', 'no-session');
  const result = await runSudo(client, `cat -- ${quoteShellArg(remotePath)}`, { password });
  const content = result.stdout;
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
