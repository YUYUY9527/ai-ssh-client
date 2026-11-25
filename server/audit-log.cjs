'use strict';

/**
 * 全局操作审计日志（JSONL 追加写入 DATA_DIR/audit.log）：
 * 记录 SSH 连接/断开、SFTP 写删改、端口转发、Docker 操作、批量任务、用户/鉴权变更等。
 * 绝不记录密码、私钥、TOTP 密钥或命令 stdout 敏感数据。
 */

const fs = require('node:fs');
const path = require('node:path');

const AUDIT_FILE = 'audit.log';
const MAX_DETAIL_CHARS = 400;

function createAuditLogger(dataDir) {
  const filePath = path.join(String(dataDir || '.'), AUDIT_FILE);

  function record(entry) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const clean = {
        ts: new Date().toISOString(),
        category: String(entry.category || 'settings'),
        action: String(entry.action || 'unknown'),
        ...(entry.actor ? { actor: String(entry.actor) } : {}),
        ...(entry.connectionId ? { connectionId: String(entry.connectionId) } : {}),
        ...(entry.target ? { target: String(entry.target).slice(0, 200) } : {}),
        outcome: entry.outcome === 'error' || entry.outcome === 'denied' ? entry.outcome : 'ok',
        ...(entry.detail ? { detail: String(entry.detail).slice(0, MAX_DETAIL_CHARS) } : {}),
      };
      fs.appendFileSync(filePath, `${JSON.stringify(clean)}\n`, { mode: 0o600 });
    } catch {
      // 审计写盘失败不阻断主业务
    }
  }

  function query({ category = '', search = '', limit = 200 } = {}) {
    const maxItems = Math.max(1, Math.min(1000, Number(limit) || 200));
    if (!fs.existsSync(filePath)) return [];
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    const cat = String(category || '').trim().toLowerCase();
    const q = String(search || '').trim().toLowerCase();
    const lines = raw.split('\n').filter(Boolean);
    const results = [];
    for (let i = lines.length - 1; i >= 0 && results.length < maxItems; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (cat && String(parsed.category || '').toLowerCase() !== cat) continue;
        if (q) {
          const hay = `${parsed.action || ''} ${parsed.actor || ''} ${parsed.target || ''} ${parsed.detail || ''} ${parsed.connectionId || ''}`.toLowerCase();
          if (!hay.includes(q)) continue;
        }
        results.push(parsed);
      } catch {
        // 忽略损坏行
      }
    }
    return results;
  }

  return { record, query, filePath };
}

module.exports = { createAuditLogger, AUDIT_FILE };
