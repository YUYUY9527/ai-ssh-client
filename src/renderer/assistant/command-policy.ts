import type { CommandSuggestion } from '../../shared/types';

const RISK_WEIGHTS: Record<CommandSuggestion['riskLevel'], number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Returns whether a command suggestion must be approved by the user. */
export function requiresCommandApproval(
  suggestion: CommandSuggestion,
  minimumRisk: CommandSuggestion['riskLevel'] = 'medium',
): boolean {
  return RISK_WEIGHTS[suggestion.riskLevel] >= RISK_WEIGHTS[minimumRisk];
}
