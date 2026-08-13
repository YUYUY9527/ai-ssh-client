// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVersionCheck } from '../src/renderer/lib/version-check';

/** 构造一个带主 chunk script 的页面。 */
function seedPage(hash: string): void {
  document.head.innerHTML = '';
  const script = document.createElement('script');
  script.src = `./assets/index-${hash}.js`;
  document.head.appendChild(script);
}

function mockFetch(html: string | null, ok = true): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    text: async () => html ?? '',
  })));
}

beforeEach(() => {
  vi.useFakeTimers();
  seedPage('abc123');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

describe('startVersionCheck', () => {
  it('服务端 hash 相同：不触发更新', async () => {
    mockFetch('<html><script src="./assets/index-abc123.js"></script></html>');
    const onUpdate = vi.fn();
    const stop = startVersionCheck(onUpdate);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUpdate).not.toHaveBeenCalled();
    stop();
  });

  it('服务端 hash 变化：触发更新并停止轮询', async () => {
    mockFetch('<html><script src="./assets/index-new456.js"></script></html>');
    const onUpdate = vi.fn();
    const stop = startVersionCheck(onUpdate);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith('new456');

    // 触发后应停止轮询：再过一个周期不重复回调
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    stop();
  });

  it('未登录（401）：跳过本轮，下一轮再试', async () => {
    mockFetch(null, false);
    const onUpdate = vi.fn();
    const stop = startVersionCheck(onUpdate);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUpdate).not.toHaveBeenCalled();

    // 登录态恢复后能检测到
    mockFetch('<html><script src="./assets/index-new456.js"></script></html>');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    stop();
  });

  it('页面无主 chunk：直接禁用检测', () => {
    document.head.innerHTML = '';
    const onUpdate = vi.fn();
    const stop = startVersionCheck(onUpdate);
    stop();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('stop 后不再检测', async () => {
    mockFetch('<html><script src="./assets/index-new456.js"></script></html>');
    const onUpdate = vi.fn();
    const stop = startVersionCheck(onUpdate);
    stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
