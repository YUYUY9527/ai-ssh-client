const posixPath = require('node:path').posix;

const NO_SUCH_FILE = 2;
const PROTECTED_PATHS = new Set(['', '/', '.', '~', '~/']);

/** 将 shell 家目录记法转换为 SFTP 协议路径。/home 是真实目录，不得映射为家目录。 */
function sftpProtocolPath(remotePath) {
  const value = String(remotePath || '').trim();
  if (!value || value === '~') {
    return '.';
  }
  if (value.startsWith('~/')) {
    return `./${value.slice(2)}`;
  }
  return value;
}

function validateItemName(name) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error('Invalid SFTP item name');
  }
}

function validateItemPath(remotePath) {
  const normalized = posixPath.normalize(sftpProtocolPath(remotePath).trim());
  if (
    typeof remotePath !== 'string'
    || PROTECTED_PATHS.has(normalized)
    || PROTECTED_PATHS.has(String(remotePath || '').trim())
  ) {
    throw new Error('Protected SFTP path');
  }
}

function siblingPath(remotePath, newName) {
  validateItemPath(remotePath);
  validateItemName(newName);
  const display = String(remotePath).replace(/\/+$/, '');
  // 保留 ~/ 展示路径，避免把家目录相对路径归一成 new.txt
  if (display === '~' || display.startsWith('~/')) {
    const parent = posixPath.dirname(display);
    return parent === '.' ? `~/${newName}` : posixPath.join(parent, newName);
  }
  const protocolPath = sftpProtocolPath(remotePath).replace(/\/+$/, '');
  return posixPath.join(posixPath.dirname(protocolPath), newName);
}

function callSftp(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });
}

async function pathExists(sftp, remotePath) {
  try {
    await callSftp(sftp, 'lstat', remotePath);
    return true;
  } catch (error) {
    if (error?.code === NO_SUCH_FILE) {
      return false;
    }
    throw error;
  }
}

async function renameSftpItem(sftp, remotePath, newName) {
  const source = sftpProtocolPath(remotePath);
  const displayDestination = siblingPath(remotePath, newName);
  const destination = sftpProtocolPath(displayDestination);
  if (await pathExists(sftp, destination)) {
    throw new Error('Destination already exists');
  }
  await callSftp(sftp, 'rename', source, destination);
  return displayDestination;
}

async function deleteSftpItem(sftp, remotePath) {
  validateItemPath(remotePath);
  const stack = [{ remotePath: sftpProtocolPath(remotePath), visited: false }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (item.visited) {
      await callSftp(sftp, 'rmdir', item.remotePath);
      continue;
    }

    const attrs = await callSftp(sftp, 'lstat', item.remotePath);
    const isDirectory = attrs.isDirectory() && !attrs.isSymbolicLink();
    if (!isDirectory) {
      await callSftp(sftp, 'unlink', item.remotePath);
      continue;
    }

    const entries = await callSftp(sftp, 'readdir', item.remotePath);
    stack.push({ remotePath: item.remotePath, visited: true });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const name = entries[index].filename;
      if (name !== '.' && name !== '..') {
        stack.push({ remotePath: posixPath.join(item.remotePath, name), visited: false });
      }
    }
  }
}

/** 创建单层远程目录；已存在时报 ALREADY_EXISTS。 */
async function createSftpDirectory(sftp, remotePath) {
  validateItemPath(remotePath);
  const normalized = posixPath.normalize(sftpProtocolPath(remotePath).replace(/\/+$/, '') || '.');
  validateItemName(posixPath.basename(normalized));
  if (await pathExists(sftp, normalized)) {
    const error = new Error('Destination already exists');
    error.code = 'already-exists';
    throw error;
  }
  await callSftp(sftp, 'mkdir', normalized);
  return normalized;
}

/** 选中父目录时去掉其后代，避免重复递归删除。 */
function collapseDescendants(paths) {
  const unique = [...new Set((paths || []).map((item) => String(item || '')).filter(Boolean))]
    .sort((left, right) => left.length - right.length);
  const roots = [];
  for (const path of unique) {
    const covered = roots.some((root) => path === root || path.startsWith(`${root}/`));
    if (!covered) roots.push(path);
  }
  return roots;
}

/** 批量删除：逐项执行并汇总成功/失败。 */
async function deleteSftpItems(sftp, remotePaths) {
  const roots = collapseDescendants(remotePaths);
  const items = [];
  let deletedCount = 0;
  let failedCount = 0;
  for (const remotePath of roots) {
    try {
      await deleteSftpItem(sftp, remotePath);
      items.push({ path: remotePath, success: true });
      deletedCount += 1;
    } catch (error) {
      items.push({
        path: remotePath,
        success: false,
        error: error?.message || String(error),
        code: error?.code === 'already-exists' ? 'already-exists' : 'io-error',
      });
      failedCount += 1;
    }
  }
  return { items, deletedCount, failedCount };
}

/** 在线编辑最大字节数（与前端/ Rust 保持一致）。 */
const MAX_SFTP_EDIT_BYTES = 2 * 1024 * 1024;

/** 读取远端文本文件；超限或非 UTF-8 时抛错。 */
async function readSftpTextFile(sftp, remotePath, maxBytes = MAX_SFTP_EDIT_BYTES) {
  validateItemPath(remotePath);
  const protocolPath = sftpProtocolPath(remotePath);
  const attrs = await callSftp(sftp, 'stat', protocolPath);
  if (typeof attrs.isDirectory === 'function' ? attrs.isDirectory() : attrs.isDirectory) {
    throw new Error('Cannot edit a directory');
  }
  const size = Number(attrs.size || 0);
  if (size > maxBytes) {
    const error = new Error(`File too large to edit (${size} bytes, max ${maxBytes} bytes)`);
    error.code = 'file-too-large';
    throw error;
  }

  const content = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const stream = sftp.createReadStream(protocolPath);
    stream.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stream.destroy();
        const error = new Error(`File too large to edit (max ${maxBytes} bytes)`);
        error.code = 'file-too-large';
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      try {
        resolve(buffer.toString('utf8'));
      } catch (error) {
        reject(error);
      }
    });
  });

  // 粗检：含大量空字节视为二进制
  if (content.includes('\u0000')) {
    throw new Error('File is not valid UTF-8 text and cannot be edited in-app');
  }

  return {
    path: remotePath,
    content,
    size: Buffer.byteLength(content, 'utf8'),
    encoding: 'utf-8',
    maxBytes,
  };
}

/**
 * 解析权限：支持八进制字符串（"644"/"0755"/"0o644"）或数字。
 * 返回 0–0o7777 的 permission bits。
 */
function parsePermissionMode(mode) {
  if (typeof mode === 'number' && Number.isFinite(mode)) {
    return mode & 0o7777;
  }
  const raw = String(mode ?? '').trim().toLowerCase();
  if (!raw) {
    throw new Error('Invalid permission mode');
  }
  const octal = raw.startsWith('0o') ? raw.slice(2) : raw.replace(/^0+(?=\d)/, '') || '0';
  if (!/^[0-7]{1,4}$/.test(octal)) {
    throw new Error('Invalid permission mode');
  }
  return parseInt(octal, 8) & 0o7777;
}

/** 修改远端文件/目录权限（chmod）。 */
async function setSftpPermissions(sftp, remotePath, mode) {
  validateItemPath(remotePath);
  const permission = parsePermissionMode(mode);
  const protocolPath = sftpProtocolPath(remotePath);
  await callSftp(sftp, 'chmod', protocolPath, permission);
  return { path: remotePath, mode: permission.toString(8).padStart(3, '0') };
}

/** 覆盖写入远端文本文件。 */
async function writeSftpTextFile(sftp, remotePath, content, maxBytes = MAX_SFTP_EDIT_BYTES) {
  validateItemPath(remotePath);
  const buffer = Buffer.from(String(content ?? ''), 'utf8');
  if (buffer.length > maxBytes) {
    const error = new Error(`Content too large to save (max ${maxBytes} bytes)`);
    error.code = 'file-too-large';
    throw error;
  }
  const protocolPath = sftpProtocolPath(remotePath);
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(protocolPath, { flags: 'w' });
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(buffer);
  });
}

module.exports = {
  MAX_SFTP_EDIT_BYTES,
  collapseDescendants,
  createSftpDirectory,
  deleteSftpItem,
  deleteSftpItems,
  parsePermissionMode,
  readSftpTextFile,
  renameSftpItem,
  setSftpPermissions,
  siblingPath,
  sftpProtocolPath,
  validateItemName,
  validateItemPath,
  writeSftpTextFile,
};
