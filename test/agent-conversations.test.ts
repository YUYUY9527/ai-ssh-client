import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentConversationStore } from '../server/agent-conversations.cjs';

const dirs: string[] = [];

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-conv-'));
  dirs.push(dir);
  return { dir, store: createAgentConversationStore({ dataDir: dir }) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('agent-conversations', () => {
  it('保存后按 clientId + connectionId 读回，并落盘', () => {
    const { dir, store } = makeStore();
    store.save('client-a', 'conn-1', {
      messages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: 1 },
        { id: 'm2', role: 'assistant', content: 'hi', timestamp: 2 },
      ],
    });
    const loaded = store.get('client-a', 'conn-1');
    expect(loaded.messages.map((message: { content: string }) => message.content)).toEqual(['hello', 'hi']);
    // 不同 client 看不到
    expect(store.get('client-b', 'conn-1').messages).toEqual([]);
    // 重新开一个 store 仍能读到（真正持久化）
    const reopened = createAgentConversationStore({ dataDir: dir });
    expect(reopened.get('client-a', 'conn-1').messages).toHaveLength(2);
  });

  it('悬空的待审批工具调用恢复后被标记为 cancelled', () => {
    const { store } = makeStore();
    store.save('c', 'conn', {
      messages: [{
        id: 'm1', role: 'assistant', content: '', timestamp: 1,
        toolCalls: [
          { id: 't1', name: 'write_file', arguments: '{}', status: 'pending' },
          { id: 't2', name: 'read_file', arguments: '{}', status: 'completed' },
        ],
      }],
    });
    const loaded = store.get('c', 'conn');
    expect(loaded.messages[0].toolCalls[0].status).toBe('cancelled');
    expect(loaded.messages[0].toolCalls[1].status).toBe('completed');
  });

  it('附件只保留白名单元数据（丢弃 dataBase64 等大字段）', () => {
    const { store } = makeStore();
    store.save('c', 'conn', {
      messages: [{
        id: 'm1', role: 'user', content: 'pic', timestamp: 1,
        attachments: [{ id: 'a1', name: 'x.png', type: 'image/png', size: 12, dataBase64: 'QUJD' }],
      }],
    });
    const attachment = store.get('c', 'conn').messages[0].attachments[0];
    expect(attachment).toEqual({ id: 'a1', name: 'x.png', type: 'image/png', size: 12 });
  });

  it('list 与 remove', () => {
    const { store } = makeStore();
    store.save('c', 'conn-1', { messages: [{ id: 'm', role: 'user', content: 'a', timestamp: 1 }] });
    store.save('c', 'conn-2', { messages: [{ id: 'm', role: 'user', content: 'b', timestamp: 2 }] });
    const list = store.list('c');
    expect(list.map((item: { connectionId: string }) => item.connectionId).sort()).toEqual(['conn-1', 'conn-2']);
    expect(store.remove('c', 'conn-1')).toBe(true);
    expect(store.get('c', 'conn-1').messages).toEqual([]);
  });
});
