import { describe, expect, it } from 'vitest';

import {
  isTerminalBroadcastEnabled,
  pickBroadcastTargets,
  setTerminalBroadcastEnabled,
} from '../src/renderer/session/terminal/terminal-broadcast';

describe('terminal-broadcast', () => {
  it('只同步可见且不同的会话，去重并排除当前会话', () => {
    const sessions = {
      s1: { connectionId: 'conn-1' },
      s2: { connectionId: 'conn-2' },
      s3: { connectionId: 'conn-2' },
      s4: { connectionId: 'conn-3' },
    };
    const targets = pickBroadcastTargets(['s1', 's2', 's3', 's4'], sessions, 'conn-1');
    expect(targets).toEqual(['conn-2', 'conn-3']);
  });

  it('跳过没有连接 id 的会话', () => {
    const targets = pickBroadcastTargets(['a', 'b'], { a: {}, b: { connectionId: 'c' } }, undefined);
    expect(targets).toEqual(['c']);
  });

  it('开关状态可切换并通知', () => {
    const states: boolean[] = [];
    expect(isTerminalBroadcastEnabled()).toBe(false);
    setTerminalBroadcastEnabled(true);
    states.push(isTerminalBroadcastEnabled());
    setTerminalBroadcastEnabled(false);
    states.push(isTerminalBroadcastEnabled());
    expect(states).toEqual([true, false]);
  });
});
