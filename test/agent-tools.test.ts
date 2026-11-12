import { describe, expect, it } from 'vitest';
import {
  listDir,
  previewWriteFile,
  readFileText,
  resolveInsideRoot,
  searchFiles,
  writeFileText,
} from '../server/agent-tools.cjs';

type FakeEntry = {
  filename: string;
  attrs: { size: number; mtime: number; isDirectory?: () => boolean; isSymbolicLink?: () => boolean };
};

function dirEntry(filename: string): FakeEntry {
  return { filename, attrs: { size: 0, mtime: 1, isDirectory: () => true } };
}

function fileEntry(filename: string, size = 0): FakeEntry {
  return { filename, attrs: { size, mtime: 2 } };
}

function symlinkEntry(filename: string): FakeEntry {
  return { filename, attrs: { size: 0, mtime: 2, isSymbolicLink: () => true } };
}

/** 逐段解析符号链接（测试只造绝对路径目标），返回 realpath 结果。 */
function makeRealpath(symlinks: Record<string, string>) {
  return (path: string, callback: (error: Error | null, resolved?: string) => void) => {
    const parts = path.split('/').filter((part) => part && part !== '.');
    const out: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        out.pop();
        continue;
      }
      out.push(part);
      let current = `/${out.join('/')}`;
      let hops = 0;
      while (symlinks[current] && hops < 8) {
        const target = symlinks[current];
        if (!target.startsWith('/')) {
          callback(new Error('unsupported relative symlink target in test'));
          return;
        }
        out.length = 0;
        for (const targetPart of target.split('/').filter((item) => item && item !== '.')) {
          if (targetPart === '..') {
            out.pop();
            continue;
          }
          out.push(targetPart);
          current = `/${out.join('/')}`;
        }
        hops += 1;
      }
    }
    callback(null, `/${out.join('/')}`);
  };
}

function fakeSftp(
  entriesByDir: Record<string, FakeEntry[]>,
  contents: Record<string, string>,
  symlinks: Record<string, string> = {},
) {
  return {
    readdir(path: string, callback: (error: Error | null, entries?: FakeEntry[]) => void) {
      callback(null, entriesByDir[path] ?? []);
    },
    realpath: makeRealpath(symlinks),
    stat(path: string, callback: (error: Error | null, attrs?: { size: number; mtime: number }) => void) {
      if (!(path in contents)) {
        callback(new Error('no such file'));
        return;
      }
      callback(null, { size: Buffer.byteLength(contents[path], 'utf8'), mtime: 2 });
    },
    readFile(path: string, callback: (error: Error | null, data?: Buffer) => void) {
      if (!(path in contents)) {
        callback(new Error('no such file'));
        return;
      }
      callback(null, Buffer.from(contents[path], 'utf8'));
    },
    writeFile(path: string, data: Buffer, callback: (error: Error | null) => void) {
      contents[path] = data.toString('utf8');
      callback(null);
    },
  };
}

describe('agent tools', () => {
  it('沙箱根目录阻止路径逃逸', () => {
    expect(resolveInsideRoot('/srv/app', 'logs/x.log')).toBe('/srv/app/logs/x.log');
    expect(() => resolveInsideRoot('/srv/app', '../etc/passwd')).toThrow(/escapes sandbox/);
    expect(resolveInsideRoot('/', '/etc/passwd')).toBe('/etc/passwd');
  });

  it('listDir 目录优先排序并支持截断标记', async () => {
    const sftp = fakeSftp(
      {
        '/srv/app': [fileEntry('b.txt', 3), dirEntry('zdir'), fileEntry('a.log', 1)],
      },
      {},
    );
    const result = await listDir(sftp, { root: '/srv/app', path: '.' });
    expect(result.entries.map((entry: { name: string }) => entry.name)).toEqual(['zdir', 'a.log', 'b.txt']);
    expect(result.truncated).toBe(false);

    const limited = await listDir(sftp, { root: '/srv/app', path: '.', limit: 2 });
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });

  it('readFileText 超过上限时报 too-large', async () => {
    const sftp = fakeSftp({}, { '/srv/app/big.txt': 'x'.repeat(20) });
    await expect(readFileText(sftp, { root: '/srv/app', path: 'big.txt', maxBytes: 10 })).rejects.toThrow(/too large/);
    const ok = await readFileText(sftp, { root: '/srv/app', path: 'big.txt' });
    expect(ok.content).toHaveLength(20);
  });

  it('writeFileText 写入并返回字节数', async () => {
    const contents: Record<string, string> = {};
    const sftp = fakeSftp({}, contents);
    const result = await writeFileText(sftp, { root: '/srv/app', path: 'new.txt', content: '你好' });
    expect(result.path).toBe('/srv/app/new.txt');
    expect(result.bytes).toBe(6);
    expect(contents['/srv/app/new.txt']).toBe('你好');
  });

  it('searchFiles 按名称递归匹配且不越界', async () => {
    const sftp = fakeSftp(
      {
        '/srv/app': [dirEntry('logs'), fileEntry('readme.md', 5)],
        '/srv/app/logs': [fileEntry('error.log', 4), { filename: '..', attrs: { size: 0, mtime: 0 } }],
      },
      {},
    );
    const result = await searchFiles(sftp, { root: '/srv/app', path: '.', query: 'log' });
    expect(result.results.map((entry: { path: string }) => entry.path)).toEqual(['/srv/app/logs/error.log']);
  });

  it('searchFiles 支持内容匹配', async () => {
    const sftp = fakeSftp({ '/srv/app': [fileEntry('config.ini', 20)] }, { '/srv/app/config.ini': 'listen=8080' });
    const result = await searchFiles(sftp, { root: '/srv/app', path: '.', contentQuery: '8080' });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].name).toBe('config.ini');
  });

  it('previewWriteFile 返回 diff 且不落盘', async () => {
    const contents: Record<string, string> = { '/srv/app/a.txt': 'keep\nold line\n' };
    const sftp = fakeSftp({}, contents);
    const preview = await previewWriteFile(sftp, {
      root: '/srv/app',
      path: 'a.txt',
      content: 'keep\nnew line\n',
    });
    expect(preview.exists).toBe(true);
    expect(preview.changed).toBe(true);
    expect(preview.diff).toContain('--- a//srv/app/a.txt');
    expect(preview.diff).toContain('-old line');
    expect(preview.diff).toContain('+new line');
    // 预览不改变原文件
    expect(contents['/srv/app/a.txt']).toBe('keep\nold line\n');
  });

  it('previewWriteFile 对新文件全量记为新增', async () => {
    const sftp = fakeSftp({}, {});
    const preview = await previewWriteFile(sftp, { root: '/srv/app', path: 'fresh.txt', content: 'a\nb' });
    expect(preview.exists).toBe(false);
    expect(preview.diff).toContain('+a');
    expect(preview.diff).toContain('+b');
  });

  it('read_file 不允许通过符号链接读出沙箱', async () => {
    const sftp = fakeSftp(
      { '/srv/app': [symlinkEntry('outside.txt')] },
      { '/etc/passwd': 'root:x:0:0' },
      { '/srv/app/outside.txt': '/etc/passwd' },
    );
    await expect(readFileText(sftp, { root: '/srv/app', path: 'outside.txt' })).rejects.toThrow(/escapes sandbox/);
  });

  it('write_file 不允许穿过符号链接父目录写沙箱外', async () => {
    const contents: Record<string, string> = { '/etc/crontab': 'existing' };
    const sftp = fakeSftp(
      { '/srv/app': [symlinkEntry('etc')] },
      contents,
      { '/srv/app/etc': '/etc' },
    );
    await expect(
      writeFileText(sftp, { root: '/srv/app', path: 'etc/evil.txt', content: 'pwned' }),
    ).rejects.toThrow(/escapes sandbox/);
    expect(contents['/etc/evil.txt']).toBeUndefined();
  });

  it('write_file 对沙箱内不存在的新文件仍可写入', async () => {
    const contents: Record<string, string> = {};
    const sftp = fakeSftp({ '/srv/app': [] }, contents, {});
    const result = await writeFileText(sftp, { root: '/srv/app', path: 'fresh/new.txt', content: 'ok' });
    expect(result.path).toBe('/srv/app/fresh/new.txt');
    expect(contents['/srv/app/fresh/new.txt']).toBe('ok');
  });

  it('list_dir 拒绝进入指向沙箱外的目录链接', async () => {
    const sftp = fakeSftp(
      { '/srv/app': [symlinkEntry('linked')], '/etc': [fileEntry('passwd', 4)] },
      {},
      { '/srv/app/linked': '/etc' },
    );
    await expect(listDir(sftp, { root: '/srv/app', path: 'linked' })).rejects.toThrow(/escapes sandbox/);
  });

  it('search_files 不递归符号链接目录、不读取符号链接内容', async () => {
    const sftp = fakeSftp(
      {
        '/srv/app': [symlinkEntry('linked'), fileEntry('note.txt', 5)],
        '/etc': [fileEntry('shadow', 6)],
      },
      {
        '/etc/shadow': 'root:$6$...',
        '/srv/app/note.txt': 'findme',
      },
      { '/srv/app/linked': '/etc' },
    );
    // 名称匹配不到任何文件（不递归链接目录，/etc/shadow 只能靠内容命中）
    const byName = await searchFiles(sftp, { root: '/srv/app', path: '.', query: 'zzz-nonexistent' });
    expect(byName.results).toHaveLength(0);
    // 内容匹配也不会去读链接目标里的文件（note.txt 内容是 findme，不含 $6$）
    const byContent = await searchFiles(sftp, { root: '/srv/app', path: '.', query: 'zzz-nonexistent', contentQuery: '$6$' });
    expect(byContent.results).toHaveLength(0);
  });
});
