import { useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, XCircle, ShieldAlert, Save } from 'lucide-react';
import { useI18n } from '../i18n';
import type { CommandSuggestion } from '../../shared/types';
import { rememberRiskDecision } from '../assistant/risk-approval-memory';
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
  const { t } = useI18n();

  const getRiskColor = () => {
    switch (command.riskLevel) {
      case 'critical':
        return {
          bg: 'bg-red-500/10',
          border: 'border-red-500',
          text: 'text-danger',
          iconBg: 'bg-red-500',
        };
      case 'high':
        return {
          bg: 'bg-orange-500/10',
          border: 'border-orange-500',
          text: 'text-orange-500',
          iconBg: 'bg-orange-500',
        };
      case 'medium':
        return {
          bg: 'bg-yellow-500/10',
          border: 'border-yellow-500',
          text: 'text-warning',
          iconBg: 'bg-yellow-500',
        };
      default:
        return {
          bg: 'bg-green-500/10',
          border: 'border-green-500',
          text: 'text-success',
          iconBg: 'bg-green-500',
        };
    }
  };

  const getRiskIcon = () => {
    switch (command.riskLevel) {
      case 'critical':
        return <ShieldAlert className="w-6 h-6" />;
      case 'high':
        return <AlertTriangle className="w-6 h-6" />;
      case 'medium':
        return <AlertTriangle className="w-6 h-6" />;
      default:
        return <CheckCircle2 className="w-6 h-6" />;
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
    // 会话级记忆：后续同风险等级可跳过弹窗
    if (rememberEnabled && rememberChoice) {
      rememberRiskDecision(command.riskLevel, 'approved');
    }
    onApprove();
  };

  const handleReject = () => {
    if (rememberEnabled && rememberChoice) {
      rememberRiskDecision(command.riskLevel, 'rejected');
    }
    onReject();
  };

  return (
    <Modal
      isOpen
      onClose={handleReject}
      size="lg"
      showClose={false}
      panelClassName={`border-2 ${colors.border}`}
      initialFocusRef={rejectButtonRef}
    >
      <div className={`border-b border-[color-mix(in_srgb,var(--border-color)_80%,transparent)] p-4 sm:p-5 ${colors.bg}`}>
          <div className="flex items-start gap-4">
            <div className={`${colors.iconBg} rounded-md p-3 text-white`}>
              {getRiskIcon()}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{t('commandApproval.title')}</h3>
                <span className={`rounded-sm border px-2 py-0.5 text-xs font-medium ${colors.bg} ${colors.border} ${colors.text}`}>
                  {getRiskLabel()}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{command.description}</p>
            </div>
          </div>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          <div>
            <label className="industrial-field-label">
              {t('commandApproval.commandToExecute')}
            </label>
            <div className="industrial-card p-4">
              <code className="break-all font-mono text-sm text-accent">
                {command.command}
              </code>
            </div>
          </div>

          {command.riskDescription && (
            <div className="rounded-md border p-4" style={{ borderColor: 'color-mix(in srgb, var(--danger) 50%, var(--border-color))', background: 'var(--danger-muted)' }}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-danger" />
                <div>
                  <h4 className="text-sm font-medium text-danger">{t('commandApproval.riskWarning')}</h4>
                  <p className="mt-1 text-sm opacity-90">{command.riskDescription}</p>
                </div>
              </div>
            </div>
          )}

          {rememberEnabled && (
            <div className="flex items-center gap-2 p-3 industrial-card">
              <button
                type="button"
                role="checkbox"
                aria-checked={rememberChoice}
                onClick={() => setRememberChoice(!rememberChoice)}
                className={`flex h-5 w-5 items-center justify-center rounded border-2 transition-colors ${
                  rememberChoice
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]'
                    : 'border-[var(--border-color)] hover:border-[var(--accent-primary)]'
                }`}
              >
                {rememberChoice && (
                  <Check className="h-3 w-3 text-white" />
                )}
              </button>
              <div className="flex-1">
                <span className="flex items-center gap-1.5 text-sm text-slate-700 dark:text-slate-300">
                  <Save className="w-3.5 h-3.5" />
                  {t('commandApproval.rememberChoice')}
                </span>
                <p className="text-xs text-slate-500">{t('commandApproval.rememberChoiceDesc')}</p>
              </div>
            </div>
          )}

          <div className="text-xs text-slate-500 industrial-card p-3">
            <p>{t('commandApproval.confirmHint')}</p>
          </div>
        </div>

        <div className="industrial-modal-footer">
          <button
            type="button"
            ref={rejectButtonRef}
            onClick={handleReject}
            className="industrial-button-secondary"
          >
            <XCircle className="w-4 h-4" />
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
            <CheckCircle2 className="w-4 h-4" />
            {command.riskLevel === 'critical' ? t('commandApproval.confirmDangerous') : t('commandApproval.confirmExecute')}
          </button>
        </div>
    </Modal>
  );
}
