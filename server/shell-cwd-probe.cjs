/**
 * 在交互式 shell 上探测真实 PWD，供终端右键打开 SFTP 使用。
 * SFTP 通道的 cwd 固定是登录家目录，不能反映 shell 里 cd 后的位置。
 */

const PWD_TOKEN_RE = /__AIS_PWD_[A-Za-z0-9]+__/g;
const PWD_RESULT_RE = /__AIS_PWD_[A-Za-z0-9]+__:([^\r\n]+)/;
const PWD_COMMAND_RE = /stty -echo 2>\/dev\/null; printf[^\r\n]*/g;

/** 生成一次性探测 token。 */
function makePwdProbeToken() {
  return `__AIS_PWD_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}__`;
}

/** 从广播文本中剔除探测命令与结果行，避免污染终端画面。 */
function stripPwdProbeArtifacts(text) {
  if (!text || !text.includes('__AIS_PWD_')) {
    // 无 token 时仍可能只回显了 stty 行
    if (text && /stty -echo 2>\/dev\/null; printf/.test(text)) {
      return text
        .replace(PWD_COMMAND_RE, '')
        .replace(/\r\n?\r\n?/g, '\r\n');
    }
    return text;
  }

  return text
    .replace(PWD_RESULT_RE, '')
    .replace(PWD_COMMAND_RE, '')
    .replace(PWD_TOKEN_RE, '')
    // 清理探测留下的空行噪声
    .replace(/(?:\r?\n){3,}/g, '\r\n\r\n');
}

/**
 * 在当前交互 PTY 上执行静默 pwd 探测。
 * @returns {Promise<string>} 绝对路径（或 shell 返回的 PWD 原文）
 */
function probeInteractivePwd(session, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 2500);

  return new Promise((resolve, reject) => {
    const stream = session?.stream;
    if (!stream || !session.ready) {
      reject(new Error('SSH session is not connected'));
      return;
    }

    const token = makePwdProbeToken();
    const resultRe = new RegExp(
      `${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([^\\r\\n]+)`,
    );
    let buffer = '';
    let settled = false;

    const finish = (error, cwd) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stream.off('data', onData);
      if (session.cwdProbeToken === token) {
        session.cwdProbeToken = null;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(cwd);
    };

    const onData = (data) => {
      buffer += typeof data === 'string' ? data : data.toString('utf8');
      // 只保留尾部，避免 buffer 无限涨
      if (buffer.length > 8192) {
        buffer = buffer.slice(-8192);
      }
      const match = buffer.match(resultRe);
      if (!match) {
        return;
      }
      const cwd = String(match[1] || '').trim();
      if (!cwd) {
        return;
      }
      finish(null, cwd);
    };

    session.cwdProbeToken = token;
    stream.on('data', onData);

    // \r 回到行首，避免拼到用户未提交的半行输入上；关回显后打印 token:PWD
    const command = [
      '\rstty -echo 2>/dev/null;',
      `printf '%s:%s\\n' '${token}' "$PWD";`,
      'stty echo 2>/dev/null\n',
    ].join(' ');

    try {
      stream.write(command);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const timer = setTimeout(() => {
      finish(new Error('pwd probe timeout'));
    }, timeoutMs);
  });
}

module.exports = {
  makePwdProbeToken,
  probeInteractivePwd,
  stripPwdProbeArtifacts,
};
