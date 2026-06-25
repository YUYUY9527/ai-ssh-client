import type { CommandSuggestion } from '../../shared/types';
import { useAIStore } from '../store/useAIStore';
import { requiresCommandApproval } from './command-policy';

export interface CommandApprovalRequest {
  requiresApproval: boolean;
  suggestion: CommandSuggestion;
}

/** Builds approval requests for assistant-proposed terminal commands. */
export function createCommandApprovalRequest(command: string): CommandApprovalRequest {
  const suggestion = useAIStore.getState().analyzeCommand(command);

  return {
    requiresApproval: requiresCommandApproval(suggestion),
    suggestion,
  };
}
