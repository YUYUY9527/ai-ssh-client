import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AppSettings, SSHConnection } from '../../shared/types';
import type { Session } from '../../shared/types';
import { SessionTerminal } from '../session/SessionTerminal';
import { SftpSidebar } from '../transfer/SftpSidebar';
import { WorkspaceEmptyState, type WorkspaceHomeSettingsTab } from './WorkspaceEmptyState';
import { WorkspaceLayout } from './WorkspaceLayout';
import { X } from 'lucide-react';
import {
  MAX_PANES,
  collectDividers,
  collectLeaves,
  countLeaves,
  hitTest,
  leavesRects,
  type DividerRect,
  type PaneSide,
  type Rect,
} from './paneLayout';
import { clampSplitRatio, useWorkspaceStore } from './useWorkspaceStore';

interface DropHint {
  kind: 'split' | 'replace' | 'swap';
  targetTabId: string;
  side?: PaneSide;
  /** 预览矩形，单位 0~1（相对容器） */
  rect: Rect;
  label: string;
}

export interface WorkspaceTab {
  id: string;
  name: string;
  isConnected: boolean;
  isConnecting: boolean;
  lastError?: string;
  restoredFromScrollback?: boolean;
  state?: Session['state'];
}

interface SessionWorkspaceProps {
  activeTabId: string | null;
  tabs: WorkspaceTab[];
  connections: SSHConnection[];
  isSftpSidebarOpen: boolean;
  onPasteToAI: (text: string) => void;
  onCloseSftpSidebar: () => void;
  onConnect: (connectionId: string, connectionName: string) => void;
  onCreateConnection: () => void;
  onOpenSettings: (tab: WorkspaceHomeSettingsTab) => void;
  onOpenAssistant: () => void;
  onFocusTab?: (tabId: string) => void;
  theme: 'dark' | 'light' | 'system';
  settings: AppSettings;
  onSettingsPatch?: (patch: Partial<AppSettings>) => void | Promise<void>;
  translate?: (key: string, params?: Record<string, string | number>) => string;
  /** 当前正在拖拽的标签 id（来自标签栏 dragState），用于识别「拖已显示面板去交换」。 */
  draggingTabId?: string | null;
}

const EDGE_ZONE = 0.3;

/** Renders the active session terminal(s) and its session-bound SFTP sidebar. */
export function SessionWorkspace({
  activeTabId,
  tabs,
  connections,
  isSftpSidebarOpen,
  onPasteToAI,
  onCloseSftpSidebar,
  onConnect,
  onCreateConnection,
  onOpenSettings,
  onOpenAssistant,
  onFocusTab,
  theme,
  settings,
  onSettingsPatch,
  translate,
  draggingTabId,
}: SessionWorkspaceProps) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  // 侧栏绑定活动标签；断线时仍保留会话上下文，方便查看任务与上次路径
  const activeConnectionId = activeTab?.id ?? null;
  const isLive = Boolean(activeTab?.isConnected);

  const paneRoot = useWorkspaceStore((state) => state.paneRoot);
  const splitPane = useWorkspaceStore((state) => state.splitPane);
  const replacePane = useWorkspaceStore((state) => state.replacePane);
  const swapPanes = useWorkspaceStore((state) => state.swapPanes);
  const setSplitRatioById = useWorkspaceStore((state) => state.setSplitRatioById);

  const containerRef = useRef<HTMLDivElement>(null);
  const [draggingDividerId, setDraggingDividerId] = useState<string | null>(null);
  const dividerDragRef = useRef<{ id: string; orientation: 'row' | 'column'; parent: Rect } | null>(null);
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  // 当前真正显示在屏幕上的面板矩形（未分屏时就是活动会话全屏）
  const leafRects = useMemo(() => {
    if (paneRoot) return leavesRects(paneRoot);
    return activeTabId ? [{ tabId: activeTabId, x: 0, y: 0, w: 1, h: 1 }] : [];
  }, [paneRoot, activeTabId]);
  const rectByTab = useMemo(() => {
    const map = new Map<string, Rect>();
    for (const r of leafRects) map.set(r.tabId, { x: r.x, y: r.y, w: r.w, h: r.h });
    return map;
  }, [leafRects]);
  const isSplit = leafRects.length > 1;
  const atCapacity = countLeaves(paneRoot) >= MAX_PANES;

  const dividers = useMemo(() => collectDividers(paneRoot), [paneRoot]);

  /** 根据鼠标位置计算落点提示（分割到某一侧 / 替换某个面板）。 */
  const computeDropHint = useCallback((clientX: number, clientY: number): DropHint | null => {
    const container = containerRef.current;
    if (!container) return null;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    const px = (clientX - bounds.left) / bounds.width;
    const py = (clientY - bounds.top) / bounds.height;

    const target = paneRoot
      ? hitTest(paneRoot, px, py)
      : (activeTabId ? { tabId: activeTabId, x: 0, y: 0, w: 1, h: 1 } : null);
    if (!target) return null;

    // 拖的是「已经显示在别处的面板」→ 交换两个面板的位置
    if (draggingTabId) {
      const shown = paneRoot ? collectLeaves(paneRoot) : (activeTabId ? [activeTabId] : []);
      if (shown.includes(draggingTabId)) {
        if (target.tabId === draggingTabId) return null;
        return {
          kind: 'swap',
          targetTabId: target.tabId,
          rect: target,
          label: translate?.('workspace.split.swapPane') ?? '交换面板',
        };
      }
    }

    const rx = (px - target.x) / target.w;
    const ry = (py - target.y) / target.h;
    const distances: Array<{ side: PaneSide; d: number }> = [
      { side: 'left', d: rx },
      { side: 'right', d: 1 - rx },
      { side: 'top', d: ry },
      { side: 'bottom', d: 1 - ry },
    ];
    distances.sort((a, b) => a.d - b.d);
    const nearest = distances[0];
    const side = nearest.d <= EDGE_ZONE ? nearest.side : null;

    if (!side || atCapacity) {
      const label = atCapacity && side
        ? (translate?.('workspace.split.capacityReplace') ?? `已有 ${MAX_PANES} 个面板，将替换此面板`)
        : (translate?.('workspace.split.replacePane') ?? '替换此面板');
      return { kind: 'replace', targetTabId: target.tabId, rect: target, label };
    }

    let rect: Rect;
    if (side === 'left') rect = { x: target.x, y: target.y, w: target.w / 2, h: target.h };
    else if (side === 'right') rect = { x: target.x + target.w / 2, y: target.y, w: target.w / 2, h: target.h };
    else if (side === 'top') rect = { x: target.x, y: target.y, w: target.w, h: target.h / 2 };
    else rect = { x: target.x, y: target.y + target.h / 2, w: target.w, h: target.h / 2 };

    const label = side === 'left' || side === 'right'
      ? (translate?.('workspace.split.enableRight') ?? '左右分屏')
      : (translate?.('workspace.split.enableDown') ?? '上下分屏');
    return { kind: 'split', targetTabId: target.tabId, side, rect, label };
  }, [paneRoot, activeTabId, atCapacity, translate, draggingTabId]);

  const isTabDrag = (event: React.DragEvent) => (
    event.dataTransfer.types.includes('application/x-workspace-tab')
  );

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!isTabDrag(event)) return;
    event.preventDefault();
    // 拖标签是「移动」语义；dropEffect 必须与 dragstart 的 effectAllowed 兼容，
    // 否则浏览器会取消 drop（表现就是能看到预览、松手却什么也不发生）。
    event.dataTransfer.dropEffect = 'move';
    setDropHint(computeDropHint(event.clientX, event.clientY));
  }, [computeDropHint]);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropHint(null);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (isTabDrag(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
    const draggedId = event.dataTransfer.getData('application/x-workspace-tab')
      || event.dataTransfer.getData('text/plain');
    setDropHint(null);
    if (!draggedId || !tabs.some((tab) => tab.id === draggedId)) return;
    const hint = computeDropHint(event.clientX, event.clientY);
    if (!hint) return;
    event.preventDefault();
    if (hint.kind === 'swap') {
      swapPanes(draggedId, hint.targetTabId);
      return;
    }
    const visibleIds = collectLeaves(paneRoot);
    if (visibleIds.length === 0 && activeTabId) visibleIds.push(activeTabId);
    if (visibleIds.includes(draggedId)) return; // 已在某个面板里显示，忽略
    if (hint.kind === 'split' && hint.side) {
      splitPane(hint.targetTabId, draggedId, hint.side);
    } else {
      replacePane(hint.targetTabId, draggedId);
    }
  }, [tabs, paneRoot, activeTabId, computeDropHint, splitPane, replacePane, swapPanes]);

  const handleDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>, divider: DividerRect) => {
    event.preventDefault();
    event.stopPropagation();
    dividerDragRef.current = { id: divider.id, orientation: divider.orientation, parent: divider.parent };
    setDraggingDividerId(divider.id);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 某些环境不支持 setPointerCapture，忽略
    }
  };

  const handleDividerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dividerDragRef.current;
    const container = containerRef.current;
    if (!drag || !container) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const px = (event.clientX - bounds.left) / bounds.width;
    const py = (event.clientY - bounds.top) / bounds.height;
    const ratio = drag.orientation === 'row'
      ? (px - drag.parent.x) / drag.parent.w
      : (py - drag.parent.y) / drag.parent.h;
    setSplitRatioById(drag.id, clampSplitRatio(ratio));
  };

  const handleDividerPointerUp = () => {
    dividerDragRef.current = null;
    setDraggingDividerId(null);
  };

  const sidebar = isSftpSidebarOpen ? (
    <SftpSidebar
      connectionId={activeConnectionId}
      isLive={isLive}
      onClose={onCloseSftpSidebar}
    />
  ) : null;

  return (
    <WorkspaceLayout sidebar={sidebar}>
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {tabs.map((tab) => {
          const rect = rectByTab.get(tab.id);
          if (!rect) {
            return null;
          }
          const isFocused = tab.id === activeTabId;
          const style: CSSProperties = {
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
          };
          return (
            <div
              key={tab.id}
              className={`absolute flex flex-col overflow-hidden ${isFocused && isSplit ? 'outline outline-1 -outline-offset-1 outline-accent' : ''}`}
              style={style}
              onPointerDown={() => onFocusTab?.(tab.id)}
            >
              {isSplit && (
                <div className="pointer-events-none absolute right-3 top-[3.25rem] z-raised flex max-w-[70%] items-center gap-1 truncate rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] font-medium text-fg-secondary shadow-sm">
                  <span
                    className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tab.isConnected ? 'bg-success' : tab.isConnecting ? 'bg-warning' : 'bg-danger'}`}
                  />
                  <span className="truncate">{tab.name}</span>
                </div>
              )}
              <SessionTerminal
                liveConnectionId={tab.isConnected ? tab.id : null}
                sessionId={tab.id}
                onPasteToAI={onPasteToAI}
                theme={theme}
                settings={settings}
                onSettingsPatch={onSettingsPatch}
                compact={isSplit}
              />
            </div>
          );
        })}
        {dividers.map((divider) => {
          const isActive = draggingDividerId === divider.id;
          const style: CSSProperties = divider.orientation === 'row'
            ? {
              left: `${divider.x * 100}%`,
              top: `${divider.y * 100}%`,
              width: 6,
              height: `${divider.h * 100}%`,
              transform: 'translateX(-3px)',
            }
            : {
              left: `${divider.x * 100}%`,
              top: `${divider.y * 100}%`,
              width: `${divider.w * 100}%`,
              height: 6,
              transform: 'translateY(-3px)',
            };
          return (
            <div
              key={divider.id}
              role="separator"
              aria-orientation={divider.orientation === 'row' ? 'vertical' : 'horizontal'}
              className={`group absolute z-raised ${divider.orientation === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'} ${isActive ? 'bg-accent' : 'bg-transparent hover:bg-accent-muted'}`}
              style={style}
              onPointerDown={(event) => handleDividerPointerDown(event, divider)}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              onPointerCancel={handleDividerPointerUp}
            >
              <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-surface px-1 text-[10px] text-fg-muted opacity-0 group-hover:opacity-100">
                ⋯
              </div>
            </div>
          );
        })}
        {isSplit && (
          <button
            type="button"
            onClick={() => useWorkspaceStore.getState().resetLayout()}
            title={translate?.('workspace.split.disable') ?? '取消分屏'}
            aria-label={translate?.('workspace.split.disable') ?? '取消分屏'}
            className="absolute right-1.5 top-1.5 z-popover flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted shadow-sm hover:text-danger"
          >
            <X className="h-3 w-3" />
          </button>
        )}
        {dropHint && (
          <div
            className="pointer-events-none absolute z-popover flex items-center justify-center rounded-md border-2 border-accent bg-accent-muted"
            style={{
              left: `${dropHint.rect.x * 100}%`,
              top: `${dropHint.rect.y * 100}%`,
              width: `${dropHint.rect.w * 100}%`,
              height: `${dropHint.rect.h * 100}%`,
            }}
          >
            <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg shadow-sm">
              {dropHint.label}
            </span>
          </div>
        )}
      </div>
      {tabs.length === 0 && (
        <WorkspaceEmptyState
          connections={connections}
          onConnect={onConnect}
          onCreateConnection={onCreateConnection}
          onOpenSettings={onOpenSettings}
          onOpenAssistant={onOpenAssistant}
        />
      )}
    </WorkspaceLayout>
  );
}
