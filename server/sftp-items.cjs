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

module.exports = {
  deleteSftpItem,
  renameSftpItem,
  siblingPath,
  validateItemName,
  validateItemPath,
};
