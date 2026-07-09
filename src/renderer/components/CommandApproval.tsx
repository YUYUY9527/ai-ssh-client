import { useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, XCircle, ShieldAlert, Save } from 'lucide-react';
import { useI18n } from '../i18n';
import type { CommandSuggestion } from '../../shared/types';

interface CommandApprovalProps {
  command: CommandSuggestion;
  onApprove: () => void;
  onReject: () => void;
}

export function CommandApproval({ command, onApprove, onReject }: CommandApprovalProps) {
  const [rememberChoice, setRememberChoice] = useState(false);
  const { t } = useI18n();

  const getRiskColor = () => {
    switch (command.riskLevel) {
      case 'critical':
        return {
          bg: 'bg-red-500/10',
          border: 'border-red-500',
          text: 'text-red-500',
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
          text: 'text-yellow-500',
          iconBg: 'bg-yellow-500',
        };
      default:
        return {
          bg: 'bg-green-500/10',
          border: 'border-green-500',
          text: 'text-green-500',
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
    if (rememberChoice) {
      localStorage.setItem(`risk_approval_${command.riskLevel}`, 'approved');
    }
    onApprove();
  };

  const handleReject = () => {
    if (rememberChoice) {
      localStorage.setItem(`risk_approval_${command.riskLevel}`, 'rejected');
    }
    onReject();
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className={`industrial-modal border-2 ${colors.border} w-full max-w-lg`}>
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
            <label className="mb-2 block text-xs font-semibold uppercase text-slate-500">
              {t('commandApproval.commandToExecute')}
            </label>
            <div className="industrial-card p-4">
              <code className="break-all font-mono text-sm text-emerald-700 dark:text-green-400">
                {command.command}
              </code>
            </div>
          </div>

          {command.riskDescription && (
            <div className="rounded-md border border-red-500/50 bg-red-500/10 p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-medium text-red-600 dark:text-red-400">{t('commandApproval.riskWarning')}</h4>
                  <p className="mt-1 text-sm text-red-700 dark:text-red-300">{command.riskDescription}</p>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 p-3 industrial-card">
            <button
              type="button"
              role="checkbox"
              aria-checked={rememberChoice}
              onClick={() => setRememberChoice(!rememberChoice)}
              className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${
                rememberChoice
                  ? 'bg-teal-500 border-teal-500'
                  : 'border-slate-500 hover:border-teal-400'
              }`}
            >
              {rememberChoice && (
                <Check className="w-3 h-3 text-white" />
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

          <div className="text-xs text-slate-500 industrial-card p-3">
            <p>{t('commandApproval.confirmHint')}</p>
          </div>
        </div>

        <div className="industrial-modal-footer">
          <button
            type="button"
            onClick={handleReject}
            className="industrial-button-secondary"
          >
            <XCircle className="w-4 h-4" />
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={handleApprove}
            className={`${
              command.riskLevel === 'critical'
                ? 'industrial-button-danger'
                : command.isDangerous
                ? 'industrial-button-danger border-orange-600 bg-orange-600 hover:bg-orange-500'
                : 'industrial-button-primary'
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            {command.riskLevel === 'critical' ? t('commandApproval.confirmDangerous') : t('commandApproval.confirmExecute')}
          </button>
        </div>
      </div>
    </div>
  );
}
