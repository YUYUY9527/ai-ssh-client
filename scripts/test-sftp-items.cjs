const assert = require('node:assert/strict');

const {
  deleteSftpItem,
  renameSftpItem,
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

  console.log('sftp item tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
