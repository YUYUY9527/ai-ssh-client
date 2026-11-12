import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAcpRegistry } from '../server/agent-acp-registry.cjs';

const dirs: string[] = [];

afterEach(() => {
  dirs.splice(0);
});

function makeRegistry() {
  const dataDir = mkdtempSync(join(tmpdir(), 'acp-registry-'));
  dirs.push(dataDir);
  return createAcpRegistry({ dataDir });
}

describe('createAcpRegistry', () => {
  it('初始配置：默认关闭、无智能体', () => {
    const registry = makeRegistry();
    expect(registry.load()).toEqual({ enabled: false, agents: [] });
  });

  it('save 规范化：丢弃缺 name/command 的条目，裁剪 args 与数量', () => {
    const registry = makeRegistry();
    const saved = registry.save({
      enabled: true,
      agents: [
        { name: 'claude', command: 'claude-code-acp', args: ['--model', 'sonnet', 42, null] },
        { name: '', command: 'x' },
        { name: 'bad', command: '' },
        'not-an-object',
      ],
    });
    expect(saved.enabled).toBe(true);
    expect(saved.agents).toEqual([{ name: 'claude', command: 'claude-code-acp', args: ['--model', 'sonnet'] }]);
  });

  it('save 落盘且可重新读取（原子写）', () => {
    const registry = makeRegistry();
    registry.save({ enabled: true, agents: [{ name: 'codex', command: 'codex-acp', args: [] }] });
    const registry2 = createAcpRegistry({ dataDir: registry.filePath.slice(0, registry.filePath.lastIndexOf('agent-external-agents.json') - 1) });
    expect(registry2.load()).toEqual({ enabled: true, agents: [{ name: 'codex', command: 'codex-acp', args: [] }] });
  });

  it('get 按名称查找，未命中返回 null', () => {
    const registry = makeRegistry();
    registry.save({ enabled: false, agents: [{ name: 'a', command: 'cmd-a', args: [] }] });
    expect(registry.get('a')?.command).toBe('cmd-a');
    expect(registry.get('nope')).toBeNull();
  });

  it('异常 JSON 不抛出，回退默认配置', () => {
    const registry = makeRegistry();
    writeFileSync(registry.filePath, '{broken json', 'utf8');
    expect(registry.load()).toEqual({ enabled: false, agents: [] });
  });
});
