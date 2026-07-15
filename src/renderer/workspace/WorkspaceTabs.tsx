import type { DragEvent, MouseEvent } from 'react';
import { X } from 'lucide-react';

import type { WorkspaceTab } from './SessionWorkspace';

interface DragState {
  isDragging: boolean;
  draggedTabId: string | null;
  dragOverTabId: string | null;
}

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  dragState: DragState;
  onDragStart: (event: DragEvent, tabId: string) => void;
  onDragOver: (event: DragEvent, tabId: string) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent, tabId: string) => void;
  onDragEnd: () => void;
  onTabClick: (tabId: string) => void;
  onTabContextMenu: (event: MouseEvent, tab: WorkspaceTab) => void;
  onCloseTab: (event: MouseEvent, tabId: string) => void;
}

/** Session tab strip for the workspace. */
export function WorkspaceTabs({
  tabs,
  activeTabId,
  dragState,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onTabClick,
  onTabContextMenu,
  onCloseTab,
}: WorkspaceTabsProps) {
  if (tabs.length === 0) {
    return null;
  }

  const getTabStatusClass = (tab: WorkspaceTab) => {
    if (tab.restoredFromScrollback) return 'status-dot-idle';
    if (tab.state === 'error') return 'status-dot-error';
    if (tab.isConnecting) return 'status-dot-connecting';
    if (tab.isConnected) return 'status-dot-connected';
    return 'status-dot-idle';
  };

  return (
    <div
      className="workspace-tabbar scrollbar-thin scrollbar-thumb-slate-300 dark:scrollbar-thumb-slate-600 scrollbar-track-transparent"
      onWheel={(event) => {
        // 标签溢出时将纵向滚轮转为横向滚动，方便浏览大量标签
        if (event.deltaY !== 0) {
          event.currentTarget.scrollLeft += event.deltaY;
        }
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          draggable
          onDragStart={(event) => onDragStart(event, tab.id)}
          onDragOver={(event) => onDragOver(event, tab.id)}
          onDragLeave={onDragLeave}
          onDrop={(event) => onDrop(event, tab.id)}
          onDragEnd={onDragEnd}
          onClick={() => onTabClick(tab.id)}
          onAuxClick={(event) => {
            // 鼠标中键关闭标签
            if (event.button === 1) {
              event.preventDefault();
              onCloseTab(event, tab.id);
            }
          }}
          onContextMenu={(event) => onTabContextMenu(event, tab)}
          className={`workspace-tab group ${
            activeTabId === tab.id ? 'workspace-tab-active' : ''
          } ${dragState.dragOverTabId === tab.id ? 'ring-1 ring-[color-mix(in_srgb,var(--accent-primary)_50%,transparent)] bg-[color-mix(in_srgb,var(--accent-primary)_10%,transparent)]' : ''} ${
            dragState.isDragging && dragState.draggedTabId === tab.id ? 'opacity-50' : ''
          }`}
        >
          <span className={`status-dot ${getTabStatusClass(tab)}`} />
          <span className="max-w-32 truncate">{tab.name}</span>
          <button
            type="button"
            onClick={(event) => onCloseTab(event, tab.id)}
            className="workspace-tab-close"
            aria-label="Close tab"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
