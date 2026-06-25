import type { CommandHistoryItem, QuickCommand, QuickCommandGroup } from '../../../shared/types';
import type {
  CommandHistoryResult,
  IPCResult,
  QuickCommandGroupsResult,
  QuickCommandsResult,
} from '../../../shared/ipc-types';
import { tauriInvoke } from '../native';

export const nativeHistory = {
  getCommandHistory: (): Promise<IPCResult<CommandHistoryResult<CommandHistoryItem>>> => (
    tauriInvoke<CommandHistoryResult<CommandHistoryItem>>('get_command_history')
  ),
  addCommandHistory: (item: CommandHistoryItem): Promise<IPCResult> => (
    tauriInvoke<void>('add_command_history', { item })
  ),
  clearCommandHistory: (): Promise<IPCResult> => (
    tauriInvoke<void>('clear_command_history')
  ),
  getQuickCommands: (): Promise<IPCResult<QuickCommandsResult<QuickCommand>>> => (
    tauriInvoke<QuickCommandsResult<QuickCommand>>('get_quick_commands')
  ),
  saveQuickCommand: (command: QuickCommand): Promise<IPCResult> => (
    tauriInvoke<void>('save_quick_command', { command })
  ),
  deleteQuickCommand: (commandId: string): Promise<IPCResult> => (
    tauriInvoke<void>('delete_quick_command', { commandId })
  ),
  getQuickCommandGroups: (): Promise<IPCResult<QuickCommandGroupsResult<QuickCommandGroup>>> => (
    tauriInvoke<QuickCommandGroupsResult<QuickCommandGroup>>('get_quick_command_groups')
  ),
  saveQuickCommandGroup: (group: QuickCommandGroup): Promise<IPCResult> => (
    tauriInvoke<void>('save_quick_command_group', { group })
  ),
  deleteQuickCommandGroup: (groupId: string): Promise<IPCResult> => (
    tauriInvoke<void>('delete_quick_command_group', { groupId })
  ),
};
