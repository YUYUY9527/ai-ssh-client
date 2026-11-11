'use strict';

const posixPath = require('node:path').posix;

/**
 * 远程文件搜索（经独立 exec 通道跑 find/grep，目标机零安装）。
 *
 * - 按名称：GNU find -iname 子串匹配，-printf 输出类型+路径（需 GNU find）。
 * - 按内容：grep -rIl 列出包含匹配的文本文件（跳过二进制）。
 * 两者都 head 截断结果数、超时由 execCommand 控制，避免大目录树拖垮会话。
 * 所有用户输入（路径/关键词）都经 shellQuote 转义，杜绝命令注入。
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** POSIX 单引号转义：把字符串安全包进单引号，内部单引号用 '\\'' 拼接。 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** 转义 find glob 元字符，使关键词按字面子串匹配。 */
function escapeGlob(value) {
  return String(value).replace(/[\\*?[\]]/g, (char) => `\\${char}`);
}

function clampLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function buildSearchCommand({ path, query, mode = 'name', limit } = {}) {
  const remotePath = String(path || '.');
  const keyword = String(query || '');
  const max = clampLimit(limit);
  const quotedPath = shellQuote(remotePath);

  if (mode === 'content') {
    return `grep -rIl -e ${shellQuote(keyword)} ${quotedPath} 2>/dev/null | head -n ${max}`;
  }
  const pattern = `*${escapeGlob(keyword)}*`;
  return `find ${quotedPath} -iname ${shellQuote(pattern)} -printf '%y\\t%p\\n' 2>/dev/null | head -n ${max}`;
}

function toResult(filePath, typeChar) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return null;
  return {
    path: normalized,
    name: posixPath.basename(normalized),
    isDirectory: typeChar === 'd',
    isSymbolicLink: typeChar === 'l',
  };
}

/** 解析搜索输出为结果列表。name 模式形如 "f\\t/path"；content 模式每行一个路径。 */
function parseSearchOutput(text, mode = 'name') {
  const results = [];
  const seen = new Set();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let result;
    if (mode === 'name' && line.includes('\t')) {
      const tabIndex = line.indexOf('\t');
      result = toResult(line.slice(tabIndex + 1), line.slice(0, tabIndex));
    } else {
      result = toResult(line, 'f');
    }
    if (!result || seen.has(result.path)) continue;
    seen.add(result.path);
    results.push(result);
  }
  return results;
}

module.exports = {
  buildSearchCommand,
  parseSearchOutput,
  shellQuote,
  escapeGlob,
  clampLimit,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};