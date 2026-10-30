import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { clientHasLiveSocket, createSessionCleanup } = require(
  path.join(ROOT, 'server', 'session-cleanup.cjs'),
) as {
  clientHasLiveSocket: (sockets: Iterable<any>, clientId: string) => boolean;
  createSessionCleanup: (options: {
    sockets: Iterable<any>;
    sessions: Map<string, any>;
    closeSessionByKey: (key: string) => void;
    graceMs?: number;
    setTimer?: (callback: () => void, waitMs: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  }) => {
    schedule: (clientId: string, waitMs?: number) => void;
    cancel: (clientId: string) => void;
  };
};

function makeSocket({
  clientId,
  sshClientId,
  open = true,
}: {
  clientId?: string;
  sshClientId?: string;
  open?: boolean;
}) {
  return { OPEN: 1, readyState: open ? 1 : 3, clientId, sshClientId };
}

describe('clientHasLiveSocket', () => {
  it('只有打开的 socket 才算活跃，clientId 或 sshClientId 命中即可', () => {
    const sockets = [
      makeSocket({ clientId: 'a', open: false }),
      makeSocket({ sshClientId: 'a' }),
      makeSocket({ clientId: 'b' }),
    ];

    expect(clientHasLiveSocket(sockets, 'a')).toBe(true);
    expect(clientHasLiveSocket(sockets, 'c')).toBe(false);
    expect(clientHasLiveSocket([], 'a')).toBe(false);
    expect(clientHasLiveSocket(sockets, '')).toBe(false);
  });
});

describe('createSessionCleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const sockets = new Set<any>();
    const sessions = new Map<string, any>([
      ['shared::a', { clientId: 'a', connectionId: 'shared' }],
      ['other::b', { clientId: 'b', connectionId: 'other' }],
    ]);
    const closed: string[] = [];
    const cleanup = createSessionCleanup({
      sockets,
      sessions,
      closeSessionByKey: (key) => closed.push(key),
      graceMs: 1000,
    });
    return { sockets, sessions, closed, cleanup };
  }

  it('宽限期后只清理目标 client 的会话，不动其他客户端', () => {
    const { closed, cleanup } = setup();

    cleanup.schedule('a');
    vi.advanceTimersByTime(999);
    expect(closed).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(closed).toEqual(['shared::a']);
  });

  it('旧 socket 的 close 晚于新 socket identify 时不排清理（回归：误杀重连新会话）', () => {
    const { sockets, closed, cleanup } = setup();
    sockets.add(makeSocket({ sshClientId: 'a' }));

    cleanup.schedule('a');
    vi.advanceTimersByTime(5000);

    expect(closed).toEqual([]);
  });

  it('定时器等待期间同 clientId 重连，触发时也不清理', () => {
    const { sockets, closed, cleanup } = setup();

    cleanup.schedule('a');
    vi.advanceTimersByTime(500);
    sockets.add(makeSocket({ sshClientId: 'a' }));
    vi.advanceTimersByTime(500);

    expect(closed).toEqual([]);
  });

  it('cancel 能取消尚未触发的清理', () => {
    const { closed, cleanup } = setup();

    cleanup.schedule('a');
    cleanup.cancel('a');
    vi.advanceTimersByTime(5000);

    expect(closed).toEqual([]);
  });

  it('空 clientId 不排清理', () => {
    const { closed, cleanup } = setup();

    cleanup.schedule('');
    vi.advanceTimersByTime(5000);

    expect(closed).toEqual([]);
  });
});
