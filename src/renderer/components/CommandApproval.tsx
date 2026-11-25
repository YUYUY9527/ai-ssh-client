import { useId, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, XCircle, ShieldAlert, Save } from 'lucide-react';
import { useI18n } from '../i18n';
import type { CommandSuggestion } from '../../shared/types';
import { rememberCommandDecision } from '../assistant/risk-approval-memory';
import { Modal } from '../shared-ui/Modal';

interface CommandApprovalProps {
  command: CommandSuggestion;
  onApprove: () => void;
  onReject: () => void;
  /** When false, hide remember checkbox and do not persist decisions. */
  rememberEnabled?: boolean;
}

export function CommandApproval({
  command,
  onApprove,
  onReject,
  rememberEnabled = true,
}: CommandApprovalProps) {
  const [rememberChoice, setRememberChoice] = useState(false);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const rememberLabelId = useId();
  const { t } = useI18n();

  const getRiskColor = () => {
    switch (command.riskLevel) {
      case 'critical':
        return {
          bg: 'bg-danger-muted',
          border: 'border-danger',
          text: 'text-danger-fg',
          iconClass: 'border-[color-mix(in_srgb,var(--danger)_45%,var(--border-color))] bg-danger-muted text-danger-fg',
          badgeClass: 'border-[color-mix(in_srgb,var(--danger)_45%,var(--border-color))] bg-surface text-danger-fg',
        };
      case 'high':
        return {
          bg: 'bg-accent-strong-muted',
          border: 'border-accent-strong',
          text: 'text-accent-strong',
          iconClass: 'border-[color-mix(in_srgb,var(--accent-strong)_45%,var(--border-color))] bg-accent-strong-muted text-accent-strong',
          badgeClass: 'border-[color-mix(in_srgb,var(--accent-strong)_45%,var(--border-color))] bg-surface text-accent-strong',
        };
      case 'medium':
        return {
          bg: 'bg-warning-muted',
          border: 'border-warning',
          text: 'text-warning-fg',
          iconClass: 'border-[color-mix(in_srgb,var(--warning)_45%,var(--border-color))] bg-warning-muted text-warning-fg',
          badgeClass: 'border-[color-mix(in_srgb,var(--warning)_45%,var(--border-color))] bg-surface text-warning-fg',
        };
      default:
        return {
          bg: 'bg-success-muted',
          border: 'border-success',
          text: 'text-success-fg',
          iconClass: 'border-[color-mix(in_srgb,var(--success)_45%,var(--border-color))] bg-success-muted text-success-fg',
          badgeClass: 'border-[color-mix(in_srgb,var(--success)_45%,var(--border-color))] bg-surface text-success-fg',
        };
    }
  };

  const getRiskIcon = () => {
    switch (command.riskLevel) {
      case 'critical':
        return <ShieldAlert className="h-6 w-6" />;
      case 'high':
        return <AlertTriangle className="h-6 w-6" />;
      case 'medium':
        return <AlertTriangle className="h-6 w-6" />;
      default:
        return <CheckCircle2 className="h-6 w-6" />;
    }
  };

  const getRiskLabel = () => {
    switch (command.riskLevel) {
      case 'critical':
        return t('commandApproval.riskLevels.critical');
      case 'high':
        return t('commandApproval.riskLevels.high');
      case 'medium':
        return t('commandApproval.riskLevels.medium');
      default:
        return t('commandApproval.riskLevels.low');
    }
  };

  const colors = getRiskColor();

  const handleApprove = () => {
    // 会话级记忆：仅对这条具体命令生效（critical 不记忆）
    if (rememberEnabled && rememberChoice) {
      rememberCommandDecision(command.command, command.riskLevel, 'approved');
    }
    onApprove();
  };

  const handleReject = () => {
    if (rememberEnabled && rememberChoice) {
      rememberCommandDecision(command.command, command.riskLevel, 'rejected');
    }
    onReject();
  };

  return (
    <Modal
      isOpen
      onClose={handleReject}
      size="lg"
      showClose={false}
      labelledBy={titleId}
      describedBy={descId}
      panelClassName={`flex flex-col !overflow-hidden border-2 ${colors.border}`}
      initialFocusRef={rejectButtonRef}
    >
      <div className={`shrink-0 border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] p-4 sm:p-5 ${colors.bg}`}>
        <div className="flex items-start gap-3.5">
          <div className={`shrink-0 rounded-md border p-2.5 ${colors.iconClass}`}>
            {getRiskIcon()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 id={titleId} className="text-lg font-semibold text-fg">{t('commandApproval.title')}</h3>
              <span className={`rounded-sm border px-2 py-0.5 text-xs font-medium ${colors.badgeClass}`}>
                {getRiskLabel()}
              </span>
            </div>
            <p id={descId} className="mt-1 text-sm text-fg-secondary">{command.description}</p>
          </div>
        </div>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
        <div>
          <label className="industrial-field-label">
            {t('commandApproval.commandToExecute')}
          </label>
          <div className="industrial-card scrollbar-thin max-h-56 overflow-auto p-3.5">
            <code className="block whitespace-pre-wrap break-all font-mono text-sm text-accent">
              {command.command}
            </code>
          </div>
        </div>

        {command.riskDescription && (
          <div
            className="rounded-md border p-3.5"
            style={{ borderColor: 'color-mix(in srgb, var(--danger) 45%, var(--border-color))', background: 'var(--danger-muted)' }}
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger-fg" />
              <div className="min-w-0 flex-1">
                <h4 className="text-sm font-medium text-danger-fg">{t('commandApproval.riskWarning')}</h4>
                <p className="mt-1 break-words text-sm text-danger-fg opacity-90">{command.riskDescription}</p>
              </div>
            </div>
          </div>
        )}

        {rememberEnabled && command.riskLevel !== 'critical' && (
          <div
            onClick={() => setRememberChoice((prev) => !prev)}
            className="industrial-card flex cursor-pointer items-center gap-2.5 p-3 transition-colors hover:border-line-strong"
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={rememberChoice}
              aria-labelledby={rememberLabelId}
              onClick={(event) => {
                event.stopPropagation();
                setRememberChoice((prev) => !prev);
              }}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 transition-colors ${
                rememberChoice
                  ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]'
                  : 'border-[var(--border-color)] hover:border-[var(--accent-primary)]'
              }`}
            >
              {rememberChoice && (
                <Check className="h-3 w-3 text-white" />
              )}
            </button>
            <div id={rememberLabelId} className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-sm text-fg-secondary">
                <Save className="h-3.5 w-3.5 shrink-0" />
                {t('commandApproval.rememberChoice')}
              </span>
              <p className="text-xs text-fg-muted">{t('commandApproval.rememberCommandChoiceDesc')}</p>
            </div>
          </div>
        )}

        <div className="industrial-card p-3 text-xs text-fg-muted">
          <p>{t('commandApproval.confirmHint')}</p>
        </div>
      </div>

      <div className="industrial-modal-footer shrink-0">
        <button
          type="button"
          ref={rejectButtonRef}
          onClick={handleReject}
          className="industrial-button-secondary"
        >
          <XCircle className="h-4 w-4" />
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={handleApprove}
          className={
            command.riskLevel === 'critical' || command.isDangerous
              ? 'industrial-button-danger'
              : 'industrial-button-primary'
          }
        >
          <CheckCircle2 className="h-4 w-4" />
          {command.riskLevel === 'critical' ? t('commandApproval.confirmDangerous') : t('commandApproval.confirmExecute')}
        </button>
      </div>
    </Modal>
  );
}
