import { useRef } from 'react';
import { AlertTriangle, CheckCircle2, ShieldAlert, XCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import type { HostTrustPromptEvent } from '../../shared/types';
import { Modal } from '../shared-ui/Modal';

interface HostTrustPromptProps {
  prompt: HostTrustPromptEvent;
  onAccept: () => void;
  onReject: () => void;
}

/** 首次连接 / 密钥变更时的主机指纹确认弹窗 */
export function HostTrustPrompt({ prompt, onAccept, onReject }: HostTrustPromptProps) {
  const { t } = useI18n();
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const isKeyChanged = prompt.kind === 'keyChanged';

  return (
    <Modal
      isOpen
      onClose={onReject}
      size="md"
      showClose={false}
      panelClassName={isKeyChanged
        ? 'border-2 border-[color-mix(in_srgb,var(--danger)_70%,transparent)]'
        : 'border-2 border-[color-mix(in_srgb,var(--warning)_70%,transparent)]'}
      initialFocusRef={rejectButtonRef}
    >
      <div
        className="border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] p-4 sm:p-5"
        style={{ background: isKeyChanged ? 'var(--danger-muted)' : 'var(--warning-muted)' }}
      >
        <div className="flex items-start gap-4">
          <div
            className="rounded-md p-3 text-white"
            style={{ background: isKeyChanged ? 'var(--danger)' : 'var(--warning)' }}
          >
            {isKeyChanged ? <ShieldAlert className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              {isKeyChanged
                ? t('hostTrust.keyChangedTitle')
                : t('hostTrust.firstConnectTitle')}
            </h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {isKeyChanged
                ? t('hostTrust.keyChangedDesc')
                : t('hostTrust.firstConnectDesc')}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        <div className="industrial-card space-y-2 p-3 text-sm">
          <div className="flex justify-between gap-3">
            <span className="text-slate-500">{t('hostTrust.host')}</span>
            <span className="font-mono text-slate-800 dark:text-slate-100">
              {prompt.host}:{prompt.port}
            </span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-slate-500">{t('hostTrust.algorithm')}</span>
            <span className="font-mono text-slate-800 dark:text-slate-100">{prompt.algorithm}</span>
          </div>
        </div>

        <div>
          <label className="industrial-field-label">
            {t('hostTrust.fingerprint')}
          </label>
          <div className="industrial-card p-3">
            <code className="break-all font-mono text-xs text-accent">
              {prompt.fingerprint}
            </code>
          </div>
        </div>

        {isKeyChanged && prompt.previousFingerprint && (
          <div
            className="rounded-md border p-3"
            style={{ borderColor: 'color-mix(in srgb, var(--danger) 40%, var(--border-color))', background: 'var(--danger-muted)' }}
          >
            <div className="mb-2 flex items-center gap-2 text-sm font-medium text-danger">
              <AlertTriangle className="h-4 w-4" />
              {t('hostTrust.previousFingerprint')}
            </div>
            {prompt.previousAlgorithm && (
              <p className="mb-1 text-xs opacity-90">
                {prompt.previousAlgorithm}
              </p>
            )}
            <code className="break-all font-mono text-xs text-danger">
              {prompt.previousFingerprint}
            </code>
          </div>
        )}

        <div className="industrial-card p-3 text-xs text-slate-500">
          <p>
            {isKeyChanged
              ? t('hostTrust.keyChangedHint')
              : t('hostTrust.firstConnectHint')}
          </p>
        </div>
      </div>

      <div className="industrial-modal-footer">
        <button
          type="button"
          ref={rejectButtonRef}
          onClick={onReject}
          className="industrial-button-secondary"
        >
          <XCircle className="h-4 w-4" />
          {t('hostTrust.reject')}
        </button>
        <button
          type="button"
          onClick={onAccept}
          className={isKeyChanged
            ? 'industrial-button-danger'
            : 'industrial-button-primary'}
        >
          <CheckCircle2 className="h-4 w-4" />
          {isKeyChanged ? t('hostTrust.acceptChanged') : t('hostTrust.accept')}
        </button>
      </div>
    </Modal>
  );
}
