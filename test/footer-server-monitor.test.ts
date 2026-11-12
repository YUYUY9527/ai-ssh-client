/**
 * @vitest-environment jsdom
 *
 * 底栏服务器指标（FooterServerMonitor）的采集时机。
 *
 * 回归背景（真实反馈）：连上某台服务器变得巨慢，根因是底栏在「连接中」就开始轮询
 * 监控，而监控请求走的是会自动重连的通道，于是每 5 秒又拉起一个新的 SSH 连接、
 * 互相顶替。这里锁定：会话没连上时绝不请求，连上后才开始采集。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { FooterServerMonitor } from '../src/renderer/app/FooterServerMonitor';
import { useSessionStore } from '../src/renderer/session/useSessionStore';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const metrics = {
  cpuPercent: 5,
  memory: { usedKb: 1024, totalKb: 2048 },
  disk: { percent: 20 },
};

function session(state: string) {
  return {
    id: 'c1',
    connectionId: 'c1',
    title: '171',
    state,
    reconnectAttempts: 0,
    lastActiveAt: Date.now(),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  useSessionStore.setState({ sessions: {}, orderedSessionIds: [], activeSessionId: null });
});

describe('FooterServerMonitor 采集时机', () => {
  it('会话连接中时不请求，连上后才开始请求', async () => {
    const api = vi.fn().mockResolvedValue({ success: true, data: metrics });
    (window as unknown as { electronAPI: unknown }).electronAPI = { getServerMonitor: api };

    useSessionStore.setState({
      activeSessionId: 'c1',
      sessions: { c1: session('connecting') } as never,
      orderedSessionIds: ['c1'],
    });

    await act(async () => {
      root.render(createElement(FooterServerMonitor));
    });
    // 连接中：一次都不该请求（否则会触发自动重连、拖慢连接）
    expect(api).not.toHaveBeenCalled();

    await act(async () => {
      useSessionStore.setState({ sessions: { c1: session('connected') } as never });
    });
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('c1');
  });
});
