'use strict';

/**
 * SFTP 进阶文件操作（基于 SSH exec + 严格 POSIX 单引号转义）：
 * - 远端打包压缩（.tar.gz / .zip）与解压（.tar.gz / .tgz / .tar / .zip）
 * - 同服务器复制（cp -a）与移动（mv）
 * - 创建符号链接（ln -s）
 * - 修改文件属主/属组（chown [-R]）
 */

const posixPath = require('node:path').posix;
const { execCommand } = require('./ssh-exec.cjs');

function quoteArg(value) {
  const text = String(value ?? '');
  if (text.includes('\0')) throw new Error('Path contains NUL byte');
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function requireValidPath(value, label = 'path') {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.includes('\0')) throw new Error(`${label} contains NUL byte`);
  return text;
}

/** 打包选中的远端路径为 .tar.gz 或 .zip。 */
async function archiveRemoteItems(client, { baseDir, names, archiveName, format = 'tar.gz' }) {
  const dir = requireValidPath(baseDir, 'baseDir');
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error('At least one item is required');
  }
  const cleanNames = names.map((item) => {
    const name = requireValidPath(item, 'item');
    if (name.includes('/') || name === '..' || name === '.') {
      throw new Error(`Invalid archive entry name: ${name}`);
    }
    return name;
  });
  const ext = format === 'zip' ? '.zip' : '.tar.gz';
  const rawArchive = String(archiveName || `${cleanNames[0]}${ext}`).trim();
  const safeArchive = rawArchive.endsWith(ext) ? rawArchive : `${rawArchive}${ext}`;
  const outPath = posixPath.isAbsolute(safeArchive) ? safeArchive : posixPath.join(dir, safeArchive);

  const cmd = format === 'zip'
    ? `cd ${quoteArg(dir)} && zip -rq ${quoteArg(outPath)} -- ${cleanNames.map(quoteArg).join(' ')}`
    : `tar -czf ${quoteArg(outPath)} -C ${quoteArg(dir)} -- ${cleanNames.map(quoteArg).join(' ')}`;

  const result = await execCommand(client, cmd, { timeoutMs: 120000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'Archive failed').trim());
  }
  return { archivePath: outPath, format, count: cleanNames.length };
}

/** 解压远端压缩包（.tar.gz / .tgz / .tar / .tar.bz2 / .tar.xz / .zip）到指定目录。 */
async function extractRemoteArchive(client, { archivePath, destinationDir }) {
  const src = requireValidPath(archivePath, 'archivePath');
  const dest = requireValidPath(destinationDir || posixPath.dirname(src), 'destinationDir');
  const lower = src.toLowerCase();

  let cmd;
  if (lower.endsWith('.zip')) {
    cmd = `mkdir -p ${quoteArg(dest)} && unzip -qo ${quoteArg(src)} -d ${quoteArg(dest)}`;
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    cmd = `mkdir -p ${quoteArg(dest)} && tar -xzf ${quoteArg(src)} -C ${quoteArg(dest)}`;
  } else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) {
    cmd = `mkdir -p ${quoteArg(dest)} && tar -xjf ${quoteArg(src)} -C ${quoteArg(dest)}`;
  } else if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) {
    cmd = `mkdir -p ${quoteArg(dest)} && tar -xJf ${quoteArg(src)} -C ${quoteArg(dest)}`;
  } else if (lower.endsWith('.tar')) {
    cmd = `mkdir -p ${quoteArg(dest)} && tar -xf ${quoteArg(src)} -C ${quoteArg(dest)}`;
  } else {
    throw new Error(`Unsupported archive format: ${posixPath.basename(src)}`);
  }

  const result = await execCommand(client, cmd, { timeoutMs: 120000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'Extract failed').trim());
  }
  return { archivePath: src, destinationDir: dest };
}

/** 同服务器复制或移动文件/目录。 */
async function copyOrMoveRemoteItems(client, { sources, destinationDir, mode = 'copy' }) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('sources are required');
  }
  const dest = requireValidPath(destinationDir, 'destinationDir');
  const cleanSources = sources.map((item) => requireValidPath(item, 'source'));
  const verb = mode === 'move' ? 'mv --' : 'cp -a --';
  const cmd = `${verb} ${cleanSources.map(quoteArg).join(' ')} ${quoteArg(dest)}`;
  const result = await execCommand(client, cmd, { timeoutMs: 120000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || `${mode} failed`).trim());
  }
  return { mode, count: cleanSources.length, destinationDir: dest };
}

/** 在远端创建符号链接：ln -s <targetPath> <linkPath>。 */
async function createRemoteSymlink(client, { targetPath, linkPath }) {
  const target = requireValidPath(targetPath, 'targetPath');
  const link = requireValidPath(linkPath, 'linkPath');
  const cmd = `ln -s -- ${quoteArg(target)} ${quoteArg(link)}`;
  const result = await execCommand(client, cmd, { timeoutMs: 15000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'ln -s failed').trim());
  }
  return { targetPath: target, linkPath: link };
}

/** 修改远端文件/目录属主属组（支持 owner 或 owner:group，格式严格校验）。 */
async function chownRemoteItem(client, { remotePath, owner, group, recursive = false }) {
  const target = requireValidPath(remotePath, 'remotePath');
  const safeOwner = String(owner ?? '').trim();
  const safeGroup = String(group ?? '').trim();
  const spec = safeGroup ? `${safeOwner}:${safeGroup}` : safeOwner;
  if (!spec || !/^[A-Za-z0-9_.-]*(?::[A-Za-z0-9_.-]+)?$/.test(spec)) {
    throw new Error('Invalid owner/group specification');
  }
  const flags = recursive ? '-R ' : '';
  const cmd = `chown ${flags}-- ${quoteArg(spec)} ${quoteArg(target)}`;
  const result = await execCommand(client, cmd, { timeoutMs: 30000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'chown failed').trim());
  }
  return { remotePath: target, spec, recursive: Boolean(recursive) };
}

module.exports = {
  archiveRemoteItems,
  extractRemoteArchive,
  copyOrMoveRemoteItems,
  createRemoteSymlink,
  chownRemoteItem,
};
