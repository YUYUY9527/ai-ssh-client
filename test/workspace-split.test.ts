// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectLeaves, countLeaves, leavesRects } from '../src/renderer/workspace/paneLayout';
import {
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  useWorkspaceStore,
} from '../src/renderer/workspace/useWorkspaceStore';

describe('工作区分屏布局', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ paneRoot: null });
  });

  it('splitPane 从单面板裂成两个面板', () => {
    const ok = useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    expect(ok).toBe(true);
    expect(collectLeaves(useWorkspaceStore.getState().paneRoot)).toEqual(['s1', 's2']);
  });

  it('splitPane 拒绝相同会话与重复会话', () => {
    expect(useWorkspaceStore.getState().splitPane('s1', 's1', 'right')).toBe(false);
    expect(useWorkspaceStore.getState().paneRoot).toBeNull();
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    expect(useWorkspaceStore.getState().splitPane('s2', 's1', 'left')).toBe(false);
    expect(collectLeaves(useWorkspaceStore.getState().paneRoot)).toEqual(['s1', 's2']);
  });

  it('可以扩到最多 4 个面板，第 5 个变成替换', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    useWorkspaceStore.getState().splitPane('s1', 's3', 'bottom');
    useWorkspaceStore.getState().splitPane('s2', 's4', 'bottom');
    expect(countLeaves(useWorkspaceStore.getState().paneRoot)).toBe(4);
    const ok = useWorkspaceStore.getState().splitPane('s1', 's5', 'left');
    expect(ok).toBe(false);
    // 达到上限后用 s5 替换 s1
    expect(collectLeaves(useWorkspaceStore.getState().paneRoot)).toContain('s5');
    expect(countLeaves(useWorkspaceStore.getState().paneRoot)).toBe(4);
  });

  it('四面板布局矩形铺满且互不重叠', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    useWorkspaceStore.getState().splitPane('s1', 's3', 'bottom');
    useWorkspaceStore.getState().splitPane('s2', 's4', 'bottom');
    const rects = leavesRects(useWorkspaceStore.getState().paneRoot);
    expect(rects).toHaveLength(4);
    const total = rects.reduce((sum, r) => sum + r.w * r.h, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('replacePane 用新会话替换指定面板', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    useWorkspaceStore.getState().replacePane('s1', 's9');
    expect(collectLeaves(useWorkspaceStore.getState().paneRoot)).toEqual(['s9', 's2']);
  });

  it('swapPanes 交换两个已显示会话的面板位置', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    useWorkspaceStore.getState().splitPane('s1', 's3', 'bottom');
    const before = collectLeaves(useWorkspaceStore.getState().paneRoot);
    useWorkspaceStore.getState().swapPanes('s1', 's3');
    const after = collectLeaves(useWorkspaceStore.getState().paneRoot);
    expect(after.indexOf('s1')).toBe(before.indexOf('s3'));
    expect(after.indexOf('s3')).toBe(before.indexOf('s1'));
    // 集合不变
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('removePane 在只剩一个面板时收回单面板', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    useWorkspaceStore.getState().removePane('s2');
    expect(useWorkspaceStore.getState().paneRoot).toBeNull();
  });

  it('prunePanes 清理已关闭的会话面板', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    useWorkspaceStore.getState().splitPane('s1', 's3', 'bottom');
    useWorkspaceStore.getState().prunePanes(['s1', 's3']);
    expect(collectLeaves(useWorkspaceStore.getState().paneRoot).sort()).toEqual(['s1', 's3']);
  });

  it('setSplitRatioById 会钳制到允许区间', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    const root = useWorkspaceStore.getState().paneRoot;
    if (!root || root.type !== 'split') throw new Error('expected split');
    useWorkspaceStore.getState().setSplitRatioById(root.id, 0.01);
    const updated = useWorkspaceStore.getState().paneRoot;
    if (!updated || updated.type !== 'split') throw new Error('expected split');
    expect(updated.ratio).toBe(SPLIT_MIN_RATIO);
    useWorkspaceStore.getState().setSplitRatioById(root.id, 0.99);
    const updated2 = useWorkspaceStore.getState().paneRoot;
    if (!updated2 || updated2.type !== 'split') throw new Error('expected split');
    expect(updated2.ratio).toBe(SPLIT_MAX_RATIO);
  });

  it('resetLayout 回到单面板', () => {
    useWorkspaceStore.getState().splitPane('s1', 's2', 'right');
    useWorkspaceStore.getState().resetLayout();
    expect(useWorkspaceStore.getState().paneRoot).toBeNull();
  });
});
