import { describe, it, expect } from 'vitest';

import {
  formatCompletionTitle,
  shouldShowDesktopNotice,
  stripCompletionTitle,
} from '../src/renderer/agent/agent-completion-notice';

/**
 * 任务完成提醒（纯逻辑部分）。
 *
 * 背景：`notifyTaskCompletion` 此前是空实现，任务跑完后用户切到别的窗口就看不到结果。
 * 现在收尾时在标题前加 ✓/✗ 标记（回到前台清除），并在**已授予**通知权限且窗口隐藏时
 * 发系统通知 —— 不主动弹权限请求。
 */

describe('formatCompletionTitle', () => {
  it('成功与失败使用不同标记', () => {
    expect(formatCompletionTitle('AI SSH Client', true)).toBe('✓ AI SSH Client');
    expect(formatCompletionTitle('AI SSH Client', false)).toBe('✗ AI SSH Client');
  });

  it('重复标记不会叠加', () => {
    const once = formatCompletionTitle('AI SSH Client', true);
    const twice = formatCompletionTitle(once, false);
    expect(twice).toBe('✗ AI SSH Client');
  });

  it('清除标记后恢复原标题', () => {
    expect(stripCompletionTitle('✓ AI SSH Client')).toBe('AI SSH Client');
    expect(stripCompletionTitle('✗ AI SSH Client')).toBe('AI SSH Client');
    expect(stripCompletionTitle('AI SSH Client')).toBe('AI SSH Client');
  });
});

describe('shouldShowDesktopNotice', () => {
  it('只在窗口隐藏且权限已授予时发通知', () => {
    expect(shouldShowDesktopNotice(true, 'granted')).toBe(true);
    expect(shouldShowDesktopNotice(false, 'granted')).toBe(false);
    expect(shouldShowDesktopNotice(true, 'default')).toBe(false);
    expect(shouldShowDesktopNotice(true, 'denied')).toBe(false);
    expect(shouldShowDesktopNotice(true, 'unsupported')).toBe(false);
  });
});
