import type { AppSettings } from '../../../shared/types';
import type { IPCResult, SettingsResult } from '../../../shared/ipc-types';
import { tauriInvoke } from '../native';

export const nativeSettings = {
  getSettings: (): Promise<IPCResult<SettingsResult<AppSettings>>> => (
    tauriInvoke<SettingsResult<AppSettings>>('get_settings')
  ),
  saveSettings: (settings: AppSettings): Promise<IPCResult> => (
    tauriInvoke<void>('save_settings', { settings })
  ),
};
