import type { CommandSuggestion } from '../../shared/types';

export type RiskApprovalDecision = 'approved' | 'rejected';
type RiskLevel = CommandSuggestion['riskLevel'];

const memory = new Map<RiskLevel, RiskApprovalDecision>();

/** Returns a session-scoped remembered decision for a risk level. */
export function getRememberedRiskDecision(riskLevel: RiskLevel): RiskApprovalDecision | null {
  return memory.get(riskLevel) ?? null;
}

/** Stores a session-scoped decision for a risk level. */
export function rememberRiskDecision(riskLevel: RiskLevel, decision: RiskApprovalDecision): void {
  memory.set(riskLevel, decision);
}

/** Clears all remembered risk decisions (e.g. settings toggle off). */
export function clearRememberedRiskDecisions(): void {
  memory.clear();
}

/**
 * Whether approval UI should still be shown given settings + session memory.
 * remembered "approved" skips UI; "rejected" still blocks via caller.
 */
export function shouldSkipApprovalForRisk(
  riskLevel: RiskLevel,
  rememberEnabled: boolean,
): RiskApprovalDecision | null {
  if (!rememberEnabled) {
    return null;
  }
  return getRememberedRiskDecision(riskLevel);
}
