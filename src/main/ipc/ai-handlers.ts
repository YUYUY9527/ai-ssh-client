import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { aiManager } from '../ai/manager';
import type { AIProviderConfig, Message } from '../../shared/types';
import type { IPCResult, AIChatResult, AIProvidersResult, AIProviderSecretStatusResult, ErrorResult } from '../../shared/ipc-types';
import { AIProviderError } from '../ai/provider';
import { getProviderSecretStatus } from '../ai/provider-config';

function toIPCError(error: unknown): ErrorResult {
  if (error instanceof AIProviderError) {
    return { success: false, error: error.message, code: error.code };
  }
  return { success: false, error: (error as Error).message || '未知错误' };
}

function asIPCErrorResult<T = void>(error: unknown): IPCResult<T> {
  return toIPCError(error) as IPCResult<T>;
}

export function setupAIIpcHandlers() {
  ipcMain.handle(IPC_CHANNELS.AI_CHAT, async (_event, providerId: string, messages: Message[], options?: { requestId?: string }): Promise<IPCResult<AIChatResult>> => {
    try {
      const response = await aiManager.chat(providerId, messages, options);
      return { success: true, data: response };
    } catch (error) {
      return asIPCErrorResult<AIChatResult>(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_CANCEL_CHAT, async (_event, requestId: string): Promise<IPCResult> => {
    const canceled = aiManager.cancelChat(requestId);
    return canceled
      ? { success: true }
      : { success: false, error: '请求不存在或已结束' };
  });

  ipcMain.handle(IPC_CHANNELS.AI_GET_PROVIDERS, async (): Promise<IPCResult<AIProvidersResult>> => {
    try {
      const providers = aiManager.getProviders();
      return { success: true, data: { providers } } satisfies IPCResult<AIProvidersResult>;
    } catch (error) {
      return asIPCErrorResult<AIProvidersResult>(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_SAVE_PROVIDER, async (_event, provider: AIProviderConfig): Promise<IPCResult> => {
    try {
      await aiManager.saveProvider(provider);
      return { success: true };
    } catch (error) {
      return asIPCErrorResult(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_DELETE_PROVIDER, async (_event, providerId: string): Promise<IPCResult> => {
    try {
      await aiManager.deleteProvider(providerId);
      return { success: true };
    } catch (error) {
      return asIPCErrorResult(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_SET_ACTIVE_PROVIDER, async (_event, providerId: string): Promise<IPCResult> => {
    try {
      await aiManager.setActiveProvider(providerId);
      return { success: true };
    } catch (error) {
      return asIPCErrorResult(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_TEST_PROVIDER, async (_event, config: AIProviderConfig): Promise<IPCResult<AIChatResult>> => {
    try {
      const response = await aiManager.testProvider(config);
      return { success: true, data: response } satisfies IPCResult<AIChatResult>;
    } catch (error) {
      return asIPCErrorResult<AIChatResult>(error);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_GET_PROVIDER_SECRET_STATUS, async (_event, providerId: string): Promise<IPCResult<AIProviderSecretStatusResult>> => {
    try {
      return { success: true, data: getProviderSecretStatus(providerId) };
    } catch (error) {
      return asIPCErrorResult<AIProviderSecretStatusResult>(error);
    }
  });
}
