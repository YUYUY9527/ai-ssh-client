const assert = require('node:assert/strict');

const {
  collapseDescendants,
  createSftpDirectory,
  deleteSftpItem,
  deleteSftpItems,
  parsePermissionMode,
  renameSftpItem,
  setSftpPermissions,
  siblingPath,
  validateItemName,
  validateItemPath,
} = require('../server/sftp-items.cjs');

const missing = () => Object.assign(new Error('missing'), { code: 2 });
const attrs = (directory, symbolicLink = false) => ({
  isDirectory: () => directory,
  isSymbolicLink: () => symbolicLink,
});

async function main() {
  assert.equal(siblingPath('/tmp/old.txt', 'new.txt'), '/tmp/new.txt');
  assert.equal(siblingPath('~/old.txt', 'new.txt'), '~/new.txt');
  for (const name of ['', '  ', '.', '..', 'a/b', 'a\0b']) {
    assert.throws(() => validateItemName(name), /Invalid SFTP item name/);
  }
  for (const remotePath of ['', '/', '//', '/./', '.', '~', '~/']) {
    assert.throws(() => validateItemPath(remotePath), /Protected SFTP path/);
  }

  let renamed;
  await renameSftpItem({
    lstat(_remotePath, callback) {
      callback(missing());
    },
    rename(source, destination, callback) {
      renamed = { source, destination };
      callback(null);
    },
  }, '/tmp/old.txt', 'new.txt');
  assert.deepEqual(renamed, { source: '/tmp/old.txt', destination: '/tmp/new.txt' });

  let renameCalled = false;
  await assert.rejects(renameSftpItem({
    lstat(_remotePath, callback) {
      callback(null, attrs(false));
    },
    rename(_source, _destination, callback) {
      renameCalled = true;
      callback(null);
    },
  }, '/tmp/old.txt', 'existing.txt'), /Destination already exists/);
  assert.equal(renameCalled, false);

  const nodes = new Map([
    ['/root', attrs(true)],
    ['/root/folder', attrs(true)],
    ['/root/folder/nested.txt', attrs(false)],
    ['/root/file.txt', attrs(false)],
    ['/root/link', attrs(true, true)],
  ]);
  const entries = new Map([
    ['/root', [{ filename: 'folder' }, { filename: 'file.txt' }, { filename: 'link' }]],
    ['/root/folder', [{ filename: 'nested.txt' }]],
  ]);
  const operations = [];
  await deleteSftpItem({
    lstat(remotePath, callback) {
      callback(null, nodes.get(remotePath));
    },
    readdir(remotePath, callback) {
      operations.push(`readdir:${remotePath}`);
      callback(null, entries.get(remotePath));
    },
    unlink(remotePath, callback) {
      operations.push(`unlink:${remotePath}`);
      callback(null);
    },
    rmdir(remotePath, callback) {
      operations.push(`rmdir:${remotePath}`);
      callback(null);
    },
  }, '/root');
  assert.deepEqual(operations, [
    'readdir:/root',
    'readdir:/root/folder',
    'unlink:/root/folder/nested.txt',
    'rmdir:/root/folder',
    'unlink:/root/file.txt',
    'unlink:/root/link',
    'rmdir:/root',
  ]);

  assert.deepEqual(
    collapseDescendants(['/a/b', '/a', '/a/b/c', '/z']),
    ['/a', '/z'],
  );

  let createdPath;
  await createSftpDirectory({
    lstat(_remotePath, callback) {
      callback(missing());
    },
    mkdir(remotePath, callback) {
      createdPath = remotePath;
      callback(null);
    },
  }, '/tmp/new-dir');
  assert.equal(createdPath, '/tmp/new-dir');

  await assert.rejects(createSftpDirectory({
    lstat(_remotePath, callback) {
      callback(null, attrs(true));
    },
    mkdir(_remotePath, callback) {
      callback(null);
    },
  }, '/tmp/exists'), /Destination already exists/);

  const batchNodes = new Map([
    ['/batch/file.txt', attrs(false)],
    ['/batch/dir', attrs(true)],
  ]);
  const batchResult = await deleteSftpItems({
    lstat(remotePath, callback) {
      if (!batchNodes.has(remotePath)) {
        callback(missing());
        return;
      }
      callback(null, batchNodes.get(remotePath));
    },
    readdir(remotePath, callback) {
      callback(null, remotePath === '/batch/dir' ? [] : undefined);
    },
    unlink(remotePath, callback) {
      batchNodes.delete(remotePath);
      callback(null);
    },
    rmdir(remotePath, callback) {
      batchNodes.delete(remotePath);
      callback(null);
    },
  }, ['/batch/file.txt', '/batch/dir', '/batch/file.txt', '/batch/missing']);
  assert.equal(batchResult.deletedCount, 2);
  assert.equal(batchResult.failedCount, 1);
  assert.equal(batchResult.items.length, 3);

  assert.equal(parsePermissionMode('644'), 0o644);
  assert.equal(parsePermissionMode('0755'), 0o755);
  assert.equal(parsePermissionMode('0o600'), 0o600);
  assert.equal(parsePermissionMode(0o755), 0o755);
  assert.throws(() => parsePermissionMode('999'), /Invalid permission mode/);
  assert.throws(() => parsePermissionMode(''), /Invalid permission mode/);

  let chmodArgs;
  await setSftpPermissions({
    chmod(remotePath, mode, callback) {
      chmodArgs = { remotePath, mode };
      callback(null);
    },
  }, '/tmp/a.txt', '644');
  assert.deepEqual(chmodArgs, { remotePath: '/tmp/a.txt', mode: 0o644 });

  console.log('sftp item tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
