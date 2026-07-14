import { AlertTriangle, Info } from 'lucide-react';
import { useId, useRef } from 'react';
import { useI18n } from '../i18n';
import { Modal } from '../shared-ui/Modal';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  isConfirming?: boolean;
  type?: 'warning' | 'info';
}

/** 通用确认弹窗，复用 Modal 基座获得 Esc 关闭、点遮罩关闭与焦点陷阱 */
export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  isConfirming = false,
  type = 'warning',
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const { t } = useI18n();

  const resolvedConfirmText = confirmText ?? t('common.confirm');
  const resolvedCancelText = cancelText ?? t('common.cancel');

  return (
    <Modal
      isOpen={isOpen}
      onClose={isConfirming ? () => undefined : onCancel}
      size="md"
      showClose={false}
      initialFocusRef={confirmButtonRef}
      labelledBy={titleId}
      describedBy={messageId}
    >
      <div className="industrial-modal-header">
        <div className="flex items-center gap-3">
          {type === 'warning' ? (
            <AlertTriangle className="h-5 w-5 text-orange-500" />
          ) : (
            <Info className="h-5 w-5 text-blue-500" />
          )}
          <h3 id={titleId} className="font-semibold text-slate-900 dark:text-white">
            {title}
          </h3>
        </div>
      </div>

      <div className="p-4">
        <p id={messageId} className="text-sm text-slate-600 dark:text-slate-300">
          {message}
        </p>
      </div>

      <div className="industrial-modal-footer">
        <button
          type="button"
          onClick={onCancel}
          disabled={isConfirming}
          className="industrial-button-secondary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resolvedCancelText}
        </button>
        <button
          type="button"
          ref={confirmButtonRef}
          onClick={onConfirm}
          disabled={isConfirming}
          className={`${type === 'warning' ? 'industrial-button-danger' : 'industrial-button-primary'} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {resolvedConfirmText}
        </button>
      </div>
    </Modal>
  );
}
