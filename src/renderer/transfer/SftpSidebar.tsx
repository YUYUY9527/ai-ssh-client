import { FolderX } from 'lucide-react';

import { useI18n } from '../i18n';
import { SftpBrowser } from './SftpBrowser';

interface SftpSidebarProps {
  connectionId: string | null;
  onClose: () => void;
}

/** Session-bound SFTP workspace shown beside the active terminal. */
export function SftpSidebar({ connectionId, onClose }: SftpSidebarProps) {
  const { t } = useI18n();

  return (
    <aside className="flex h-full w-[min(34rem,42vw)] min-w-[24rem] flex-col border-l border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] bg-[color-mix(in_srgb,var(--bg-primary)_82%,var(--bg-secondary))]">
      {connectionId ? (
        <SftpBrowser connectionId={connectionId} onClose={onClose} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-slate-500 dark:text-slate-400">
          <FolderX className="h-6 w-6 text-slate-400" />
          <p>{t('fileTransfer.noConnection')}</p>
        </div>
      )}
    </aside>
  );
}
