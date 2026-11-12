'use strict';

/**
 * Agent 结构化文件工具（批次一）。
 *
 * 设计要点：
 * - 所有远端路径都相对「沙箱根目录」解析，禁止 `..` 逃逸与 NUL。
 * - 大小/数量/深度都有上限，避免把大文件或目录树灌进模型上下文。
 * - 依赖注入 `sftp`（ssh2 SFTPWrapper 形状），便于用假对象做确定性单测。
 */

const posix = require('path').posix;

const MAX_READ_BYTES = 1024 * 1024; // 单文件读取上限 1 MiB
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DEPTH = 4;
const MAX_SEARCH_FILE_BYTES = 64 * 1024;

function normalizeRemotePath(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('path is required');
  }
  if (value.includes('\0')) {
    throw new Error('path contains NUL byte');
  }
  return value;
}

/**
 * 把 target 解析到 root 之内，越界直接抛错。
 * root 为 '/' 时不做前缀限制。
 */
function resolveInsideRoot(root, target) {
  const rootPath = posix.resolve(normalizeRemotePath(root || '/'));
  const abs = posix.resolve(rootPath, normalizeRemotePath(target || '.'));
  if (rootPath === '/') {
    return abs;
  }
  if (abs !== rootPath && !abs.startsWith(`${rootPath}/`)) {
    throw new Error(`path escapes sandbox: ${target}`);
  }
  return abs;
}

function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function entryType(entry) {
  const attrs = entry.attrs || {};
  if (typeof entry.directory === 'boolean') {
    return entry.directory ? 'dir' : 'file';
  }
  if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) {
    return 'dir';
  }
  if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) {
    return 'symlink';
  }
  return 'file';
}

async function listDir(sftp, options = {}) {
  const root = options.root || '/';
  const resolved = resolveInsideRoot(root, options.path || '.');
  const limit = Math.min(Math.max(Number(options.limit) || MAX_LIST_ENTRIES, 1), MAX_LIST_ENTRIES);
  const raw = await call(sftp, 'readdir', resolved);
  const entries = (raw || []).map((entry) => {
    const attrs = entry.attrs || {};
    return {
      name: entry.filename,
      type: entryType(entry),
      size: typeof attrs.size === 'number' ? attrs.size : 0,
      mtime: typeof attrs.mtime === 'number' ? attrs.mtime : 0,
    };
  });
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  return {
    path: resolved,
    entries: entries.slice(0, limit),
    truncated: entries.length > limit,
  };
}

async function statPath(sftp, root, target) {
  const resolved = resolveInsideRoot(root, target);
  const attrs = await call(sftp, 'stat', resolved);
  return { path: resolved, attrs };
}

async function readFileText(sftp, options = {}) {
  const root = options.root || '/';
  const maxBytes = Math.min(Math.max(Number(options.maxBytes) || MAX_READ_BYTES, 1), MAX_READ_BYTES);
  const { path: resolved, attrs } = await statPath(sftp, root, options.path);
  const size = typeof attrs.size === 'number' ? attrs.size : 0;
  if (size > maxBytes) {
    const error = new Error(`file too large: ${size} bytes (limit ${maxBytes})`);
    error.code = 'too-large';
    throw error;
  }
  const buffer = await call(sftp, 'readFile', resolved);
  const content = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
  return { path: resolved, size, content, truncated: false };
}

async function writeFileText(sftp, options = {}) {
  const root = options.root || '/';
  if (typeof options.content !== 'string') {
    throw new Error('content is required');
  }
  const resolved = resolveInsideRoot(root, options.path);
  await call(sftp, 'writeFile', resolved, Buffer.from(options.content, 'utf8'));
  return { path: resolved, bytes: Buffer.byteLength(options.content, 'utf8') };
}

/** 读取已存在的文本内容；不存在或不可读时返回 null（预览用，不视为错误）。 */
async function readExistingText(sftp, resolved) {
  try {
    const attrs = await call(sftp, 'stat', resolved);
    if (attrs && typeof attrs.size === 'number' && attrs.size > MAX_READ_BYTES) {
      return null;
    }
    const buffer = await call(sftp, 'readFile', resolved);
    return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
  } catch {
    return null;
  }
}

/**
 * 生成轻量 unified diff：裁掉公共前后缀，只展示中间变化段。
 * 用于 write_file 的写入前预览，避免整文件回显撑爆上下文。
 */
function buildPreviewDiff(path, oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const removed = oldLines.slice(prefix, oldLines.length - suffix);
  const added = newLines.slice(prefix, newLines.length - suffix);
  const header = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`,
  ];
  const body = [
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  return { changed: removed.length > 0 || added.length > 0, text: [...header, ...body].join('\n') };
}

/** write_file 的写入前预览：不落盘，只返回差异。 */
async function previewWriteFile(sftp, options = {}) {
  const root = options.root || '/';
  if (typeof options.content !== 'string') {
    throw new Error('content is required');
  }
  const resolved = resolveInsideRoot(root, options.path);
  const existing = await readExistingText(sftp, resolved);
  const diff = buildPreviewDiff(resolved, existing ?? '', options.content);
  return {
    path: resolved,
    exists: existing !== null,
    changed: diff.changed,
    diff: diff.text,
  };
}

async function walk(sftp, root, dir, query, contentQuery, depth, state) {
  if (depth > MAX_SEARCH_DEPTH || state.results.length >= MAX_SEARCH_RESULTS) return;
  let raw;
  try {
    raw = await call(sftp, 'readdir', dir);
  } catch {
    return;
  }
  for (const entry of raw || []) {
    if (state.results.length >= MAX_SEARCH_RESULTS) return;
    const type = entryType(entry);
    const name = entry.filename;
    if (name === '.' || name === '..') continue;
    const child = posix.join(dir, name);
    if (type === 'dir') {
      await walk(sftp, root, child, query, contentQuery, depth + 1, state);
      continue;
    }
    const attrs = entry.attrs || {};
    const size = typeof attrs.size === 'number' ? attrs.size : 0;
    let matched = !query || name.toLowerCase().includes(query.toLowerCase());
    if (!matched && contentQuery && size <= MAX_SEARCH_FILE_BYTES) {
      try {
        const buffer = await call(sftp, 'readFile', child);
        const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
        matched = text.toLowerCase().includes(contentQuery.toLowerCase());
      } catch {
        matched = false;
      }
    }
    if (matched) {
      state.results.push({ path: child, name, type, size });
    }
  }
}

async function searchFiles(sftp, options = {}) {
  const root = options.root || '/';
  const start = resolveInsideRoot(root, options.path || '.');
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const contentQuery = typeof options.contentQuery === 'string' ? options.contentQuery.trim() : '';
  const state = { results: [] };
  await walk(sftp, root, start, query, contentQuery, 0, state);
  return {
    path: start,
    results: state.results,
    truncated: state.results.length >= MAX_SEARCH_RESULTS,
  };
}

module.exports = {
  MAX_READ_BYTES,
  MAX_LIST_ENTRIES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_DEPTH,
  normalizeRemotePath,
  resolveInsideRoot,
  listDir,
  readFileText,
  writeFileText,
  previewWriteFile,
  searchFiles,
  TOOL_NAMES: ['list_dir', 'read_file', 'search_files', 'write_file'],
};
