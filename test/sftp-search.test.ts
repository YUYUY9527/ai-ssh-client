import { describe, it, expect } from 'vitest';
import {
  buildSearchCommand,
  parseSearchOutput,
  shellQuote,
  escapeGlob,
  clampLimit,
  MAX_LIMIT,
} from '../server/sftp-search.cjs';

describe('远程搜索命令构造与解析', () => {
  it('shellQuote 安全转义单引号，杜绝注入', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    expect(shellQuote('normal')).toBe("'normal'");
    const command = buildSearchCommand({ path: "/tmp/$(reboot)", query: "x'; rm -rf /", mode: 'name' });
    // 关键词里的单引号被转义成 '\''，整体仍在单引号内，不会作为独立命令执行
    expect(command).toContain("'\\''");
    expect(command).toContain("*x'\\''; rm -rf /*");
    expect(command.startsWith('find ')).toBe(true);
  });

  it('escapeGlob 转义 find 元字符使关键词按字面匹配', () => {
    expect(escapeGlob('a*b?c[d]')).toBe('a\\*b\\?c\\[d\\]');
  });

  it('name 模式用 find -iname + -printf，content 模式用 grep -rIl', () => {
    const name = buildSearchCommand({ path: '/root', query: 'nginx', mode: 'name', limit: 50 });
    expect(name).toContain('find');
    expect(name).toContain('-iname');
    expect(name).toContain('*nginx*');
    expect(name).toContain('head -n 50');

    const content = buildSearchCommand({ path: '/root', query: 'server', mode: 'content', limit: 10 });
    expect(content).toContain('grep -rIl');
    expect(content).toContain("'server'");
    expect(content).toContain('head -n 10');
  });

  it('clampLimit 归一化非法/超限值', () => {
    expect(clampLimit(undefined)).toBe(200);
    expect(clampLimit(-5)).toBe(200);
    expect(clampLimit('abc')).toBe(200);
    expect(clampLimit(5000)).toBe(MAX_LIMIT);
    expect(clampLimit(30)).toBe(30);
  });

  it('解析 name 模式 "类型\\t路径"，识别目录/软链', () => {
    const output = 'd\t/root/nginx\nf\t/root/nginx.conf\nl\t/root/link\n';
    const results = parseSearchOutput(output, 'name');
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ path: '/root/nginx', name: 'nginx', isDirectory: true });
    expect(results[1]).toMatchObject({ path: '/root/nginx.conf', name: 'nginx.conf', isDirectory: false });
    expect(results[2].isSymbolicLink).toBe(true);
  });

  it('解析 content 模式每行一个文件路径，去重去空行', () => {
    const output = '/root/a.conf\n/root/b.conf\n/root/a.conf\n\n';
    const results = parseSearchOutput(output, 'content');
    expect(results).toHaveLength(2);
    expect(results.every((item) => item.isDirectory === false)).toBe(true);
  });

  it('name 模式无类型前缀（-print 回退）也能解析', () => {
    const results = parseSearchOutput('/root/plain.txt\n', 'name');
    expect(results[0]).toMatchObject({ path: '/root/plain.txt', name: 'plain.txt', isDirectory: false });
  });
});