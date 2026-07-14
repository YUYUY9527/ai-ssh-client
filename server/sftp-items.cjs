const posixPath = require('node:path').posix;

const NO_SUCH_FILE = 2;
const PROTECTED_PATHS = new Set(['', '/', '.', '~', '~/']);

function validateItemName(name) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error('Invalid SFTP item name');
  }
}

function validateItemPath(remotePath) {
  if (
    typeof remotePath !== 'string'
    || PROTECTED_PATHS.has(posixPath.normalize(remotePath.trim()))
  ) {
    throw new Error('Protected SFTP path');
  }
}

function siblingPath(remotePath, newName) {
  validateItemPath(remotePath);
  validateItemName(newName);
  return posixPath.join(posixPath.dirname(remotePath.replace(/\/+$/, '')), newName);
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
  const destination = siblingPath(remotePath, newName);
  if (await pathExists(sftp, destination)) {
    throw new Error('Destination already exists');
  }
  await callSftp(sftp, 'rename', remotePath, destination);
  return destination;
}

async function deleteSftpItem(sftp, remotePath) {
  validateItemPath(remotePath);
  const stack = [{ remotePath, visited: false }];

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
  const normalized = posixPath.normalize(String(remotePath || '').replace(/\/+$/, '') || '/');
  validateItemPath(normalized);
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

module.exports = {
  collapseDescendants,
  createSftpDirectory,
  deleteSftpItem,
  deleteSftpItems,
  renameSftpItem,
  siblingPath,
  validateItemName,
  validateItemPath,
};
