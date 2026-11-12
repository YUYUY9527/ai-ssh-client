/**
 * 工作区分屏布局的纯函数工具（二元分割树）。
 *
 * 一个布局是一棵二叉树：叶子节点承载一个会话，分割节点把矩形按 ratio 切成两块。
 * 这样天然支持 1~4 个面板（左右/上下/2x2 网格都只是不同的树形）。
 * 所有矩形坐标都是 0~1 的相对比例，方便直接映射成百分比定位。
 */

export type SplitOrientation = 'row' | 'column';
export type PaneSide = 'left' | 'right' | 'top' | 'bottom';

export const MAX_PANES = 4;

export interface PaneLeaf {
  type: 'leaf';
  tabId: string;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  orientation: SplitOrientation;
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LeafRect extends Rect {
  tabId: string;
}

export interface DividerRect {
  id: string;
  orientation: SplitOrientation;
  /** 分割条中心线位置（0~1） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 该分割节点占据的整块区域，用于把拖拽位置换算成 ratio */
  parent: Rect;
}

let splitSeq = 0;
export function nextSplitId(): string {
  splitSeq += 1;
  return `split-${splitSeq}`;
}

export function createSplit(
  orientation: SplitOrientation,
  first: PaneNode,
  second: PaneNode,
  ratio = 0.5,
): PaneSplit {
  return { type: 'split', id: nextSplitId(), orientation, ratio, first, second };
}

export function countLeaves(node: PaneNode | null): number {
  if (!node) return 0;
  if (node.type === 'leaf') return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}

export function collectLeaves(node: PaneNode | null): string[] {
  if (!node) return [];
  if (node.type === 'leaf') return [node.tabId];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

export function leavesRects(node: PaneNode | null, rect: Rect = FULL): LeafRect[] {
  if (!node) return [];
  if (node.type === 'leaf') return [{ ...rect, tabId: node.tabId }];
  const ratio = node.ratio;
  if (node.orientation === 'row') {
    const firstW = rect.w * ratio;
    return [
      ...leavesRects(node.first, { x: rect.x, y: rect.y, w: firstW, h: rect.h }),
      ...leavesRects(node.second, { x: rect.x + firstW, y: rect.y, w: rect.w - firstW, h: rect.h }),
    ];
  }
  const firstH = rect.h * ratio;
  return [
    ...leavesRects(node.first, { x: rect.x, y: rect.y, w: rect.w, h: firstH }),
    ...leavesRects(node.second, { x: rect.x, y: rect.y + firstH, w: rect.w, h: rect.h - firstH }),
  ];
}

export function collectDividers(node: PaneNode | null, rect: Rect = FULL): DividerRect[] {
  if (!node || node.type === 'leaf') return [];
  const ratio = node.ratio;
  if (node.orientation === 'row') {
    const firstW = rect.w * ratio;
    return [
      {
        id: node.id,
        orientation: 'row',
        x: rect.x + firstW,
        y: rect.y,
        w: 0,
        h: rect.h,
        parent: rect,
      },
      ...collectDividers(node.first, { x: rect.x, y: rect.y, w: firstW, h: rect.h }),
      ...collectDividers(node.second, {
        x: rect.x + firstW,
        y: rect.y,
        w: rect.w - firstW,
        h: rect.h,
      }),
    ];
  }
  const firstH = rect.h * ratio;
  return [
    {
      id: node.id,
      orientation: 'column',
      x: rect.x,
      y: rect.y + firstH,
      w: rect.w,
      h: 0,
      parent: rect,
    },
    ...collectDividers(node.first, { x: rect.x, y: rect.y, w: rect.w, h: firstH }),
    ...collectDividers(node.second, {
      x: rect.x,
      y: rect.y + firstH,
      w: rect.w,
      h: rect.h - firstH,
    }),
  ];
}

/** 把 targetTabId 所在叶子替换为「新会话 + 原会话」的分割；返回新树与新叶子 tabId。 */
export function splitLeaf(
  node: PaneNode | null,
  targetTabId: string,
  newTabId: string,
  side: PaneSide,
): { node: PaneNode; target: string } | null {
  if (!node || node.type === 'leaf') {
    // 只有一个面板（或空布局）：以 target 为基准建分割
    const orientation: SplitOrientation = side === 'left' || side === 'right' ? 'row' : 'column';
    const first = side === 'left' || side === 'top'
      ? { type: 'leaf' as const, tabId: newTabId }
      : { type: 'leaf' as const, tabId: targetTabId };
    const second = side === 'left' || side === 'top'
      ? { type: 'leaf' as const, tabId: targetTabId }
      : { type: 'leaf' as const, tabId: newTabId };
    return { node: createSplit(orientation, first, second), target: targetTabId };
  }
  if (collectLeaves(node.first).includes(targetTabId)) {
    const result = splitLeaf(node.first, targetTabId, newTabId, side);
    if (!result) return null;
    return { node: { ...node, first: result.node }, target: result.target };
  }
  if (collectLeaves(node.second).includes(targetTabId)) {
    const result = splitLeaf(node.second, targetTabId, newTabId, side);
    if (!result) return null;
    return { node: { ...node, second: result.node }, target: result.target };
  }
  return null;
}

/** 用 newTabId 替换 targetTabId 所在叶子。 */
export function replaceLeaf(node: PaneNode | null, targetTabId: string, newTabId: string): PaneNode | null {
  if (!node) return null;
  if (node.type === 'leaf') {
    return node.tabId === targetTabId ? { type: 'leaf', tabId: newTabId } : node;
  }
  return {
    ...node,
    first: replaceLeaf(node.first, targetTabId, newTabId) ?? node.first,
    second: replaceLeaf(node.second, targetTabId, newTabId) ?? node.second,
  };
}

/** 移除某个会话所在的叶子；单个子节点会向上提，避免留下空分割。 */
export function removeLeaf(node: PaneNode | null, tabId: string): PaneNode | null {
  if (!node) return null;
  if (node.type === 'leaf') {
    return node.tabId === tabId ? null : node;
  }
  const first = removeLeaf(node.first, tabId);
  const second = removeLeaf(node.second, tabId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function setSplitRatio(node: PaneNode | null, id: string, ratio: number): PaneNode | null {
  if (!node || node.type === 'leaf') return node;
  if (node.id === id) return { ...node, ratio };
  return {
    ...node,
    first: setSplitRatio(node.first, id, ratio) ?? node.first,
    second: setSplitRatio(node.second, id, ratio) ?? node.second,
  };
}

/** 命中测试：返回坐标所在叶子及其相对矩形。 */
export function hitTest(node: PaneNode | null, x: number, y: number): LeafRect | null {
  const rects = leavesRects(node);
  for (let i = rects.length - 1; i >= 0; i -= 1) {
    const r = rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

/** 交换两个会话所在的面板位置（拖拽已显示面板到另一个面板时用）。 */
export function swapLeaves(node: PaneNode | null, aId: string, bId: string): PaneNode | null {
  if (!node) return node;
  if (node.type === 'leaf') {
    if (node.tabId === aId) return { type: 'leaf', tabId: bId };
    if (node.tabId === bId) return { type: 'leaf', tabId: aId };
    return node;
  }
  return {
    ...node,
    first: swapLeaves(node.first, aId, bId) ?? node.first,
    second: swapLeaves(node.second, aId, bId) ?? node.second,
  };
}
