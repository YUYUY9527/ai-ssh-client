import { AlertTriangle, Info } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../i18n';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
  type?: 'warning' | 'info';
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
  type = 'warning',
}: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const messageId = useId();
  const { t } = useI18n();

  const resolvedConfirmText = confirmText ?? t('common.confirm');
  const resolvedCancelText = cancelText ?? t('common.cancel');

  useEffect(() => {
    if (isOpen && confirmButtonRef.current) {
      confirmButtonRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      <div
        className="industrial-modal relative mx-4 w-full max-w-md animate-in fade-in zoom-in-95 duration-200"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
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
            className="industrial-button-secondary"
          >
            {resolvedCancelText}
          </button>
          <button
            type="button"
            ref={confirmButtonRef}
            onClick={onConfirm}
            className={type === 'warning' ? 'industrial-button-danger' : 'industrial-button-primary'}
          >
            {resolvedConfirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
