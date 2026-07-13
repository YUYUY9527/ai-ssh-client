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

    const handleMouseMove = (event: MouseEvent) => {
      const delta = startXRef.current - event.clientX;
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
      className="relative flex h-full min-w-0 flex-col border-l border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_82%,var(--bg-secondary))]"
      style={{ width }}
    >
      <div
        className={`absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors ${
          isResizing ? 'bg-teal-500/50' : 'hover:bg-teal-500/30'
        }`}
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
