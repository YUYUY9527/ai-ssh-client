const fs = require('node:fs');
const path = require('node:path');

/**
 * 审计日志（JSONL）。
 *
 * 记录「哪个工具、哪台主机、执行了什么、结果如何」，便于事后回溯 agent 的动作。
 * 不记录 stdout/stderr（可能含密钥、token），只记录长度与退出码。
 * 写盘失败不会中断工具调用，但会在 stderr 提示一次——审计不该成为可用性的单点。
 */
function createAuditLog({ file, enabled = true, maxCommandChars = 2000 } = {}) {
  let warned = false;
  const active = Boolean(enabled && file);

  function record(entry) {
    if (!active) {
      return;
    }
    const payload = {
      ts: new Date().toISOString(),
      ...entry,
    };
    if (typeof payload.command === 'string') {
      payload.command = payload.command.slice(0, maxCommandChars);
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    } catch (error) {
      if (!warned) {
        warned = true;
        console.error(`[mcp] 无法写入审计日志 ${file}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return {
    enabled: active,
    file: active ? file : null,
    record,
  };
}

module.exports = { createAuditLog };