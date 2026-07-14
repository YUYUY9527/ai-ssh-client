import type { CommandSuggestion } from '../../shared/types';
import { useAIStore } from '../store/useAIStore';
import { getAutoRejectForRisk, requiresCommandApproval } from './command-policy';

export interface CommandApprovalRequest {
  requiresApproval: boolean;
  autoRejected: boolean;
  suggestion: CommandSuggestion;
}

/** Builds approval requests for assistant-proposed terminal commands. */
export function createCommandApprovalRequest(
  command: string,
  options?: { rememberEnabled?: boolean },
): CommandApprovalRequest {
  const suggestion = useAIStore.getState().analyzeCommand(command);
  const rememberEnabled = options?.rememberEnabled !== false;
  const autoRejected = getAutoRejectForRisk(suggestion.riskLevel, rememberEnabled);

  return {
    requiresApproval: !autoRejected && requiresCommandApproval(suggestion, 'medium', { rememberEnabled }),
    autoRejected,
    suggestion,
  };
}
