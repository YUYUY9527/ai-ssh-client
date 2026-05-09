import { useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, ShieldAlert, Save } from 'lucide-react';
import type { CommandSuggestion } from '../shared/types';

interface CommandApprovalProps {
  command: CommandSuggestion;
  onApprove: () => void;
  onReject: () => void;
}

export function CommandApproval({ command, onApprove, onReject }: CommandApprovalProps) {
  const [rememberChoice, setRememberChoice] = useState(false);

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
        return '极度危险';
      case 'high':
        return '高风险';
      case 'medium':
        return '中等风险';
      default:
        return '安全';
    }
  };

  const colors = getRiskColor();

  const handleApprove = () => {
    if (rememberChoice) {
      // 保存选择到本地存储
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

  // 检查是否有记住的选择
  const savedChoice = localStorage.getItem(`risk_approval_${command.riskLevel}`);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className={`industrial-modal border-2 ${colors.border} w-full max-w-lg`}>
        <div className={`p-6 border-b border-slate-700 ${colors.bg}`}>
          <div className="flex items-start gap-4">
            <div className={`${colors.iconBg} p-3 rounded-sm`}>
              {getRiskIcon()}
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-lg text-white">命令确认</h3>
                <span className={`px-2 py-0.5 rounded-sm text-xs font-medium ${colors.bg} ${colors.text}`}>
                  {getRiskLabel()}
                </span>
              </div>
              <p className="text-slate-400 text-sm mt-1">{command.description}</p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs text-slate-500 mb-2 uppercase tracking-wider">
              将要执行的命令
            </label>
            <div className="industrial-card p-4">
              <code className="text-sm font-mono text-green-400 break-all">
                {command.command}
              </code>
            </div>
          </div>

          {command.riskDescription && (
            <div className="bg-red-500/10 border border-red-500/50 rounded-sm p-4">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-red-400 font-medium text-sm">风险警告</h4>
                  <p className="text-red-300 text-sm mt-1">{command.riskDescription}</p>
                </div>
              </div>
            </div>
          )}

          {/* 记住选择 */}
          <div className="flex items-center gap-2 p-3 industrial-card">
            <button
              onClick={() => setRememberChoice(!rememberChoice)}
              className={`w-5 h-5 rounded-sm border-2 flex items-center justify-center transition-colors ${
                rememberChoice
                  ? 'bg-blue-500 border-blue-500'
                  : 'border-slate-500 hover:border-slate-400'
              }`}
            >
              {rememberChoice && (
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
            <div className="flex-1">
              <span className="text-sm text-slate-300 flex items-center gap-1.5">
                <Save className="w-3.5 h-3.5" />
                记住本次选择
              </span>
              <p className="text-xs text-slate-500">对此风险等级的的命令，以后直接执行</p>
            </div>
          </div>

          <div className="text-xs text-slate-500 industrial-card p-3">
            <p>请仔细确认命令的正确性和安全性后再执行。</p>
          </div>
        </div>

        <div className="p-4 border-t border-slate-700 flex justify-end gap-3">
          <button
            onClick={handleReject}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-slate-700 hover:bg-slate-600 rounded-sm transition-colors text-white"
          >
            <XCircle className="w-4 h-4" />
            取消
          </button>
          <button
            onClick={handleApprove}
            className={`flex items-center gap-2 px-4 py-2 text-sm rounded-sm transition-colors ${
              command.riskLevel === 'critical'
                ? 'bg-red-600 hover:bg-red-500'
                : command.isDangerous
                ? 'bg-orange-600 hover:bg-orange-500'
                : 'bg-green-600 hover:bg-green-500'
            }`}
          >
            <CheckCircle2 className="w-4 h-4" />
            {command.riskLevel === 'critical' ? '我确认要执行此危险命令' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  );
}
