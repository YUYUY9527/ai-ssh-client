import type { CommandSuggestion } from '../../shared/types';
import {
  getRememberedCommandDecision,
  isRememberableRisk,
} from './risk-approval-memory';

const RISK_WEIGHTS: Record<CommandSuggestion['riskLevel'], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Returns whether a command suggestion must be approved by the user.
 *
 * 记忆按「具体命令」生效（见 risk-approval-memory.ts）：只有同一条命令被记住批准时
 * 才跳过审批；critical 永远需要审批。
 */
export function requiresCommandApproval(
  suggestion: CommandSuggestion,
  minimumRisk: CommandSuggestion['riskLevel'] = 'medium',
  options?: { rememberEnabled?: boolean },
): boolean {
  const rememberEnabled = options?.rememberEnabled !== false;
  if (rememberEnabled) {
    const remembered = getRememberedCommandDecision(suggestion.command, suggestion.riskLevel);
    // 已记住批准：跳过审批；已记住拒绝：仍视为需要拦截（由调用方拒绝）
    if (remembered === 'approved') {
      return false;
    }
  }
  return RISK_WEIGHTS[suggestion.riskLevel] >= RISK_WEIGHTS[minimumRisk];
}

/** Returns a remembered reject decision that should auto-block. */
export function isAutoRejected(
  command: string,
  riskLevel: CommandSuggestion['riskLevel'],
  rememberEnabled = true,
): boolean {
  if (!rememberEnabled || !isRememberableRisk(riskLevel)) {
    return false;
  }
  return getRememberedCommandDecision(command, riskLevel) === 'rejected';
}
