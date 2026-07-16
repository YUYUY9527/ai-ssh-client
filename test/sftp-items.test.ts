import { describe, it, expect } from 'vitest';
import {
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
} from '../server/sftp-items.cjs';

const missing = () => Object.assign(new Error('missing'), { code: 2 });
const attrs = (directory: boolean, symbolicLink = false) => ({
  isDirectory: () => directory,
  isSymbolicLink: () => symbolicLink,
});

describe('sftp-items', () => {
  it('computes sibling paths', () => {
    expect(siblingPath('/tmp/old.txt', 'new.txt')).toBe('/tmp/new.txt');
    expect(siblingPath('~/old.txt', 'new.txt')).toBe('~/new.txt');
  });

  it('rejects invalid item names', () => {
    for (const name of ['', '  ', '.', '..', 'a/b', 'a\0b']) {
      expect(() => validateItemName(name)).toThrow(/Invalid SFTP item name/);
    }
  });

  it('rejects protected paths', () => {
    for (const remotePath of ['', '/', '//', '/./', '.', '~', '~/']) {
      expect(() => validateItemPath(remotePath)).toThrow(/Protected SFTP path/);
    }
  });

  it('renames an item to a free destination', async () => {
    let renamed: unknown;
    await renameSftpItem({
      lstat(_remotePath: string, callback: Function) {
        callback(missing());
      },
      rename(source: string, destination: string, callback: Function) {
        renamed = { source, destination };
        callback(null);
      },
    }, '/tmp/old.txt', 'new.txt');
    expect(renamed).toEqual({ source: '/tmp/old.txt', destination: '/tmp/new.txt' });
  });

  it('refuses rename onto an existing destination', async () => {
    let renameCalled = false;
    await expect(renameSftpItem({
      lstat(_remotePath: string, callback: Function) {
        callback(null, attrs(false));
      },
      rename(_source: string, _destination: string, callback: Function) {
        renameCalled = true;
        callback(null);
      },
    }, '/tmp/old.txt', 'existing.txt')).rejects.toThrow(/Destination already exists/);
    expect(renameCalled).toBe(false);
  });

  it('deletes a directory tree depth-first', async () => {
    const nodes = new Map<string, ReturnType<typeof attrs>>([
      ['/root', attrs(true)],
      ['/root/folder', attrs(true)],
      ['/root/folder/nested.txt', attrs(false)],
      ['/root/file.txt', attrs(false)],
      ['/root/link', attrs(true, true)],
    ]);
    const entries = new Map<string, { filename: string }[]>([
      ['/root', [{ filename: 'folder' }, { filename: 'file.txt' }, { filename: 'link' }]],
      ['/root/folder', [{ filename: 'nested.txt' }]],
    ]);
    const operations: string[] = [];
    await deleteSftpItem({
      lstat(remotePath: string, callback: Function) {
        callback(null, nodes.get(remotePath));
      },
      readdir(remotePath: string, callback: Function) {
        operations.push(`readdir:${remotePath}`);
        callback(null, entries.get(remotePath));
      },
      unlink(remotePath: string, callback: Function) {
        operations.push(`unlink:${remotePath}`);
        callback(null);
      },
      rmdir(remotePath: string, callback: Function) {
        operations.push(`rmdir:${remotePath}`);
        callback(null);
      },
    }, '/root');
    expect(operations).toEqual([
      'readdir:/root',
      'readdir:/root/folder',
      'unlink:/root/folder/nested.txt',
      'rmdir:/root/folder',
      'unlink:/root/file.txt',
      'unlink:/root/link',
      'rmdir:/root',
    ]);
  });

  it('collapses descendant paths', () => {
    expect(collapseDescendants(['/a/b', '/a', '/a/b/c', '/z'])).toEqual(['/a', '/z']);
  });

  it('creates a directory when the destination is free', async () => {
    let createdPath: string | undefined;
    await createSftpDirectory({
      lstat(_remotePath: string, callback: Function) {
        callback(missing());
      },
      mkdir(remotePath: string, callback: Function) {
        createdPath = remotePath;
        callback(null);
      },
    }, '/tmp/new-dir');
    expect(createdPath).toBe('/tmp/new-dir');
  });

  it('refuses to create over an existing destination', async () => {
    await expect(createSftpDirectory({
      lstat(_remotePath: string, callback: Function) {
        callback(null, attrs(true));
      },
      mkdir(_remotePath: string, callback: Function) {
        callback(null);
      },
    }, '/tmp/exists')).rejects.toThrow(/Destination already exists/);
  });

  it('reports batch delete counts', async () => {
    const batchNodes = new Map<string, ReturnType<typeof attrs>>([
      ['/batch/file.txt', attrs(false)],
      ['/batch/dir', attrs(true)],
    ]);
    const batchResult = await deleteSftpItems({
      lstat(remotePath: string, callback: Function) {
        if (!batchNodes.has(remotePath)) {
          callback(missing());
          return;
        }
        callback(null, batchNodes.get(remotePath));
      },
      readdir(remotePath: string, callback: Function) {
        callback(null, remotePath === '/batch/dir' ? [] : undefined);
      },
      unlink(remotePath: string, callback: Function) {
        batchNodes.delete(remotePath);
        callback(null);
      },
      rmdir(remotePath: string, callback: Function) {
        batchNodes.delete(remotePath);
        callback(null);
      },
    }, ['/batch/file.txt', '/batch/dir', '/batch/file.txt', '/batch/missing']);
    expect(batchResult.deletedCount).toBe(2);
    expect(batchResult.failedCount).toBe(1);
    expect(batchResult.items.length).toBe(3);
  });

  it('parses permission modes', () => {
    expect(parsePermissionMode('644')).toBe(0o644);
    expect(parsePermissionMode('0755')).toBe(0o755);
    expect(parsePermissionMode('0o600')).toBe(0o600);
    expect(parsePermissionMode(0o755)).toBe(0o755);
    expect(() => parsePermissionMode('999')).toThrow(/Invalid permission mode/);
    expect(() => parsePermissionMode('')).toThrow(/Invalid permission mode/);
  });

  it('applies chmod through setSftpPermissions', async () => {
    let chmodArgs: unknown;
    await setSftpPermissions({
      chmod(remotePath: string, mode: number, callback: Function) {
        chmodArgs = { remotePath, mode };
        callback(null);
      },
    }, '/tmp/a.txt', '644');
    expect(chmodArgs).toEqual({ remotePath: '/tmp/a.txt', mode: 0o644 });
  });
});
