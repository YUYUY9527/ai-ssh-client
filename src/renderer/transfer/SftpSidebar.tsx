import { FolderX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n';
import { SessionOverlayProvider } from '../workspace/SessionOverlayContext';
import { useWorkspaceStore } from '../workspace/useWorkspaceStore';
import { SftpBrowser } from './SftpBrowser';
import {
  SFTP_SIDEBAR_MAX_WIDTH,
  SFTP_SIDEBAR_MIN_WIDTH,
} from './transfer-types';

export interface SftpSidebarSession {
  id: string;
  isLive: boolean;
  overlayContainer: HTMLElement | null;
}

interface SftpSidebarProps {
  connectionId: string | null;
  isLive: boolean;
  onClose: () => void;
  /** 侧栏是否展开；收起时仅隐藏侧栏本体，保留已打开会话的编辑器/预览等弹层状态。 */
  isOpen?: boolean;
  /** 已挂载的会话列表：每个会话独立维护 SFTP 实例与专属弹层宿主，切换标签互不影响。 */
  sessions?: SftpSidebarSession[];
}

/** Session-bound SFTP workspace shown beside the active terminal. */
export function SftpSidebar({
  connectionId,
  isLive,
  onClose,
  isOpen = true,
  sessions,
}: SftpSidebarProps) {
  const { t } = useI18n();
  const width = useWorkspaceStore((state) => state.sftpSidebarWidth);
  const setSftpSidebarWidth = useWorkspaceStore((state) => state.setSftpSidebarWidth);
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => {
    if (!isResizing) {
      return;
    }

    // 侧栏在左侧：向右拖加宽，向左拖收窄
    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - startXRef.current;
      setSftpSidebarWidth(startWidthRef.current + delta);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing, setSftpSidebarWidth]);

  const hasSessions = Boolean(sessions && sessions.length > 0);
  if (!isOpen && !hasSessions) {
    return null;
  }

  return (
    <aside
      className={`sftp-sidebar sftp-sidebar-left ${isOpen ? '' : 'hidden'}`}
      style={{ width }}
    >
      {/* 把手贴在侧栏右缘外侧（分界线偏右），避免压在列表内容上 */}
      <div
        className={`sftp-sidebar-resizer ${isResizing ? 'sftp-sidebar-resizer-active' : ''}`}
        onMouseDown={(event) => {
          event.preventDefault();
          startXRef.current = event.clientX;
          startWidthRef.current = width;
          setIsResizing(true);
        }}
        title={t('fileTransfer.resizeSidebar')}
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={SFTP_SIDEBAR_MIN_WIDTH}
        aria-valuemax={SFTP_SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
      />

      {hasSessions ? (
        <>
          {sessions!.map((session) => {
            const isCurrent = session.id === connectionId;
            return (
              <SessionOverlayProvider
                key={session.id}
                sessionId={session.id}
                container={session.overlayContainer}
                isActive={isCurrent}
              >
                <div className={isCurrent ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
                  <SftpBrowser
                    connectionId={session.id}
                    isLive={session.isLive}
                    onClose={onClose}
                  />
                </div>
              </SessionOverlayProvider>
            );
          })}
          {!connectionId && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-fg-muted">
              <FolderX className="h-6 w-6 text-fg-subtle" />
              <p>{t('fileTransfer.noConnection')}</p>
            </div>
          )}
        </>
      ) : connectionId ? (
        <SftpBrowser
          connectionId={connectionId}
          isLive={isLive}
          onClose={onClose}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-fg-muted">
          <FolderX className="h-6 w-6 text-fg-subtle" />
          <p>{t('fileTransfer.noConnection')}</p>
        </div>
      )}
    </aside>
  );
}
