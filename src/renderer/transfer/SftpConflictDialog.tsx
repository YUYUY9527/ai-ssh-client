import { useEffect, useState } from 'react';

import type {
  SftpConflictPolicy,
  SftpTransferTaskSnapshot,
} from '../../shared/ipc-types';
import { Modal } from '../shared-ui/Modal';

interface SftpConflictDialogProps {
  isOpen: boolean;
  isSubmitting?: boolean;
  task: SftpTransferTaskSnapshot | null;
  translate: (key: string, params?: Record<string, string | number>) => string;
  onCancel: () => void;
  onResolve: (input: {
    policy: Exclude<SftpConflictPolicy, 'ask'>;
    renamedPath?: string;
    applyToBatch: boolean;
  }) => void;
}

/** 冲突策略对话框：覆盖 / 跳过 / 重命名，可选应用到本批次。 */
export function SftpConflictDialog({
  isOpen,
  isSubmitting = false,
  task,
  translate,
  onCancel,
  onResolve,
}: SftpConflictDialogProps) {
  const suggested = task?.conflict?.suggestedName
    || task?.conflict?.destinationPath?.split(/[/\\]/).pop()
    || task?.name
    || '';
  const [policy, setPolicy] = useState<Exclude<SftpConflictPolicy, 'ask'>>('overwrite');
  const [renameName, setRenameName] = useState(suggested);
  const [applyToBatch, setApplyToBatch] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !task) return;
    setPolicy('overwrite');
    setRenameName(suggested);
    setApplyToBatch(Boolean(task.batchId));
    setError(null);
  }, [isOpen, suggested, task]);

  if (!task) return null;

  const handleSubmit = () => {
    if (policy === 'rename') {
      const name = renameName.trim();
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
        setError(translate('fileTransfer.invalidName'));
        return;
      }
      const destination = task.conflict?.destinationPath || '';
      const parent = destination.replace(/[/\\][^/\\]*$/, '');
      const separator = destination.includes('\\') ? '\\' : '/';
      const renamedPath = parent ? `${parent}${separator}${name}` : name;
      onResolve({ policy, renamedPath, applyToBatch });
      return;
    }
    onResolve({ policy, applyToBatch });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={() => {
        if (!isSubmitting) onCancel();
      }}
      title={translate('fileTransfer.conflictTitle')}
      size="sm"
      closeLabel={translate('common.close')}
    >
      <div className="space-y-3 p-4">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {translate('fileTransfer.conflictMessage', {
            name: task.name,
            path: task.conflict?.destinationPath || task.remotePath || task.localPath || task.name,
          })}
        </p>

        <div className="space-y-2">
          {([
            ['overwrite', 'fileTransfer.conflictOverwrite'],
            ['skip', 'fileTransfer.conflictSkip'],
            ['rename', 'fileTransfer.conflictRename'],
          ] as const).map(([value, labelKey]) => (
            <label key={value} className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
              <input
                type="radio"
                name="sftp-conflict-policy"
                checked={policy === value}
                disabled={isSubmitting}
                onChange={() => setPolicy(value)}
              />
              <span>{translate(labelKey)}</span>
            </label>
          ))}
        </div>

        {policy === 'rename' && (
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-500">
              {translate('fileTransfer.conflictRenameLabel')}
            </label>
            <input
              value={renameName}
              onChange={(event) => {
                setRenameName(event.target.value);
                setError(null);
              }}
              className="industrial-input w-full"
              disabled={isSubmitting}
            />
          </div>
        )}

        {task.batchId && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={applyToBatch}
              disabled={isSubmitting}
              onChange={(event) => setApplyToBatch(event.target.checked)}
            />
            <span>{translate('fileTransfer.conflictApplyBatch')}</span>
          </label>
        )}

        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      </div>

      <div className="industrial-modal-footer">
        <button
          type="button"
          className="industrial-button-secondary"
          disabled={isSubmitting}
          onClick={onCancel}
        >
          {translate('common.cancel')}
        </button>
        <button
          type="button"
          className="industrial-button-primary"
          disabled={isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? translate('common.loading') : translate('common.confirm')}
        </button>
      </div>
    </Modal>
  );
}
