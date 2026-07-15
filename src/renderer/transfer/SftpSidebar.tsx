import { FolderX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useI18n } from '../i18n';
import { useWorkspaceStore } from '../workspace/useWorkspaceStore';
import { SftpBrowser } from './SftpBrowser';
import {
  SFTP_SIDEBAR_MAX_WIDTH,
  SFTP_SIDEBAR_MIN_WIDTH,
} from './transfer-types';

interface SftpSidebarProps {
  connectionId: string | null;
  isLive: boolean;
  onClose: () => void;
}

/** Session-bound SFTP workspace shown beside the active terminal. */
export function SftpSidebar({ connectionId, isLive, onClose }: SftpSidebarProps) {
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

  return (
    <aside
      className="sftp-sidebar sftp-sidebar-left"
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

      {connectionId ? (
        <SftpBrowser
          connectionId={connectionId}
          isLive={isLive}
          onClose={onClose}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-500 dark:text-slate-400">
          <FolderX className="h-6 w-6 text-slate-400" />
          <p>{t('fileTransfer.noConnection')}</p>
        </div>
      )}
    </aside>
  );
}
