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
  attrs: { size: number; mtime: number; isDirectory?: () => boolean };
};

function dirEntry(filename: string): FakeEntry {
  return { filename, attrs: { size: 0, mtime: 1, isDirectory: () => true } };
}

function fileEntry(filename: string, size = 0): FakeEntry {
  return { filename, attrs: { size, mtime: 2 } };
}

function fakeSftp(entriesByDir: Record<string, FakeEntry[]>, contents: Record<string, string>) {
  return {
    readdir(path: string, callback: (error: Error | null, entries?: FakeEntry[]) => void) {
      callback(null, entriesByDir[path] ?? []);
    },
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
});
