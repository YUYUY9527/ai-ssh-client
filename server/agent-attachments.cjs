'use strict';

/**
 * Agent 附件存储（仅本地临时文件 + 元数据）。
 *
 * - 客户端把附件以 base64 上传，这里落成临时文件，返回 id（元数据：名/类型/大小）。
 * - 对话里只保存元数据；真正发给模型时由服务端按 id 读取并转成多模态内容块。
 * - 只接受图片/PDF/纯文本，单文件上限默认 10 MiB，超过 24 小时自动清理。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 8;
const TTL_MS = 24 * 60 * 60 * 1000;

const ALLOWED_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
]);

const EXTENSION_BY_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

function createAgentAttachmentStore({ dataDir, maxBytes = MAX_ATTACHMENT_BYTES, ttlMs = TTL_MS } = {}) {
  const directory = path.join(dataDir || path.join(__dirname, '..', 'data'), 'agent-attachments');

  function ensureDirectory() {
    fs.mkdirSync(directory, { recursive: true });
  }

  function metaPath(id) {
    return path.join(directory, `${id}.json`);
  }

  function dataPath(id, type) {
    const extension = EXTENSION_BY_TYPE[type] || 'bin';
    return path.join(directory, `${id}.${extension}`);
  }

  function readMeta(id) {
    try {
      return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * 保存附件；返回元数据（id/name/type/size/createdAt）。
   * @param {{name?:string,type?:string,dataBase64:string}} input
   */
  function save({ name, type, dataBase64 } = {}) {
    const mime = typeof type === 'string' && ALLOWED_TYPES.has(type) ? type : null;
    if (!mime) throw new Error(`unsupported attachment type: ${type || 'unknown'}`);
    if (typeof dataBase64 !== 'string' || !dataBase64) throw new Error('attachment data is empty');
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0) throw new Error('attachment data is empty');
    if (buffer.length > maxBytes) throw new Error(`attachment too large: ${buffer.length} > ${maxBytes}`);

    ensureDirectory();
    const id = crypto.randomBytes(12).toString('hex');
    const meta = {
      id,
      name: typeof name === 'string' && name ? name : `attachment-${id}`,
      type: mime,
      size: buffer.length,
      createdAt: Date.now(),
    };
    fs.writeFileSync(dataPath(id, mime), buffer);
    fs.writeFileSync(metaPath(id), JSON.stringify(meta));
    return meta;
  }

  function read(id) {
    const meta = readMeta(id);
    if (!meta) return null;
    try {
      const buffer = fs.readFileSync(dataPath(meta.id, meta.type));
      return { ...meta, dataBase64: buffer.toString('base64') };
    } catch {
      return null;
    }
  }

  function remove(id) {
    const meta = readMeta(id);
    if (!meta) return false;
    try {
      fs.unlinkSync(dataPath(meta.id, meta.type));
    } catch {
      /* 忽略 */
    }
    try {
      fs.unlinkSync(metaPath(id));
    } catch {
      /* 忽略 */
    }
    return true;
  }

  /** 清理超过 ttl 的附件，返回清理数量。 */
  function cleanup(now = Date.now()) {
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const meta = readMeta(entry.slice(0, -5));
      if (!meta || now - (meta.createdAt || 0) > ttlMs) {
        remove(entry.slice(0, -5));
        removed += 1;
      }
    }
    return removed;
  }

  return { save, read, remove, cleanup, directory, ALLOWED_TYPES, maxBytes, MAX_ATTACHMENTS_PER_MESSAGE };
}

module.exports = {
  createAgentAttachmentStore,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  ALLOWED_TYPES,
};
