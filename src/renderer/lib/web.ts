import type {
  AIProviderConfig,
  AIProviderSummary,
  AppSettings,
  CommandHistoryItem,
  QuickCommand,
  QuickCommandGroup,
  SSHConnection,
  SSHSessionState,
  Message,
  AgentTask,
  HostTrustRecord,
} from '../../shared/types';
import type {
  AIChatResult,
  AIChatStreamEvent,
  AIChatStreamOptions,
  AIProviderSecretStatusResult,
  AIProvidersResult,
  AgentExecAwaitResult,
  AgentTaskHistoryResult,
  CommandHistoryResult,
  ConnectionsResult,
  DirectoryListResult,
  ExportDataResult,
  FileDownloadResult,
  FileSelectResult,
  FileUploadResult,
  ImportDataResult,
  IPCResult,
  PrivateKeyFileResult,
  QuickCommandGroupsResult,
  QuickCommandsResult,
  SettingsResult,
  SftpTransferCompleteEvent,
  SSessionsResult,
  SSHConnectResult,
} from '../../shared/ipc-types';

type ListenerCleanup = () => void;

type EventMap = {
  'ssh-data': { connectionId: string; data: string; type?: string; state?: SSHSessionState };
  'ssh-error': { connectionId: string; error: string };
  'ssh-close': string;
  'sftp-upload-progress': { connectionId: string; taskId?: string; filename: string; progress: number };
  'sftp-download-progress': { connectionId: string; taskId?: string; filename: string; progress: number };
  'sftp-transfer-complete': SftpTransferCompleteEvent;
  'agent-terminal-output': { connectionId: string; data: string };
  'system-resume': { timestamp: number };
};

const selectedFiles = new Map<string, File>();
const listeners = new Map<keyof EventMap, Set<(payload: any) => void>>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function makeError<T = void>(message: string): IPCResult<T> {
  return { success: false, error: message };
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<IPCResult<T>> {
  try {
    const response = await fetch(path, {
      headers: options.body instanceof FormData
        ? options.headers
        : { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    return await response.json();
  } catch (error) {
    return makeError<T>(error instanceof Error ? error.message : String(error));
  }
}

async function streamWebChat(
  providerId: string,
  messages: Message[],
  options: AIChatStreamOptions,
): Promise<IPCResult<AIChatResult>> {
  try {
    const response = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ providerId, messages, options: { requestId: options.requestId } }),
    });
    if (!response.ok || !response.body) {
      return makeError(await response.text() || `AI stream failed (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let terminal: AIChatStreamEvent | null = null;

    while (!terminal) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() || '';
      for (const record of records) {
        const data = record.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as AIChatStreamEvent;
        if (event.requestId !== options.requestId) continue;
        options.onEvent(event);
        if (event.type === 'delta') {
          content += event.delta;
        } else {
          terminal = event;
          break;
        }
      }
      if (done) break;
    }
    if (!terminal) {
      reader.releaseLock();
      return makeError('AI stream disconnected before completion');
    }
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (terminal.type === 'done') {
      return {
        success: true,
        data: {
          content,
          requestId: terminal.requestId,
          model: terminal.model,
          finishReason: terminal.finishReason,
          usage: terminal.usage,
        },
      };
    }
    if (terminal.type === 'canceled') {
      return { success: false, error: 'AI request canceled', code: 'canceled' };
    }
    return { success: false, error: terminal.error, code: terminal.code };
  } catch (error) {
    return makeError(error instanceof Error ? error.message : String(error));
  }
}

function emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
  listeners.get(type)?.forEach((callback) => callback(payload));
}

function on<K extends keyof EventMap>(
  type: K,
  callback: (payload: EventMap[K]) => void,
): ListenerCleanup {
  const callbacks = listeners.get(type) || new Set();
  callbacks.add(callback);
  listeners.set(type, callbacks);

  return () => {
    callbacks.delete(callback);
  };
}

function connectEvents(): void {
  if (socket && socket.readyState < WebSocket.CLOSING) {
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);

  socket.onmessage = (event) => {
    const message = JSON.parse(event.data) as { type: keyof EventMap; payload: unknown };
    emit(message.type, message.payload as never);
  };
  socket.onclose = () => {
    socket = null;
    if (reconnectTimer == null) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectEvents();
      }, 1000);
    }
  };
}

function sendSocket(type: string, payload: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

async function writeSshInput(connectionId: string, command: string): Promise<IPCResult> {
  const result = await request<void>(`/api/ssh/${connectionId}/write`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });

  if (result.success || !result.error?.includes('SSH session is not connected')) {
    return result;
  }

  const connectionsResult = await request<ConnectionsResult<SSHConnection>>('/api/connections');
  const connection = connectionsResult.data?.connections.find((item) => item.id === connectionId);
  if (!connection) {
    return result;
  }

  const settingsResult = await request<SettingsResult<AppSettings>>('/api/settings');
  const connectResult = await request<SSHConnectResult>('/api/ssh/connect', {
    method: 'POST',
    body: JSON.stringify({
      connection,
      cols: 120,
      rows: 32,
      settings: settingsResult.data?.settings,
    }),
  });
  if (!connectResult.success) {
    return connectResult;
  }

  return request<void>(`/api/ssh/${connectionId}/write`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
}

function chooseFile(options?: {
  filters?: { name: string; extensions: string[] }[];
}): Promise<IPCResult<FileSelectResult>> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.accept = options?.filters
      ?.flatMap((filter) => filter.extensions)
      .filter((extension) => extension !== '*')
      .map((extension) => `.${extension}`)
      .join(',') || '';
    input.onchange = () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) {
        resolve({ success: true, data: { canceled: true, filePath: '', fileName: '' } });
        return;
      }

      const id = `web-file:${crypto.randomUUID()}`;
      selectedFiles.set(id, file);
      resolve({ success: true, data: { canceled: false, filePath: id, fileName: file.name } });
    };
    document.body.appendChild(input);
    input.click();
  });
}

async function readSelectedFile(filePath: string): Promise<IPCResult<PrivateKeyFileResult>> {
  const file = selectedFiles.get(filePath);
  if (!file) {
    return makeError('Selected file is no longer available');
  }

  return { success: true, data: { content: await file.text() } };
}

const webApi: Window['electronAPI'] = {
  sshConnect: (connection, cols, rows, settings) => request<SSHConnectResult>('/api/ssh/connect', {
    method: 'POST',
    body: JSON.stringify({ connection, cols, rows, settings }),
  }),
  sshDisconnect: (connectionId) => request<void>(`/api/ssh/${connectionId}/disconnect`, {
    method: 'POST',
    body: '{}',
  }),
  sshExecute: (connectionId, command) => writeSshInput(connectionId, command),
  sshExecuteSync: (connectionId, command) => {
    void writeSshInput(connectionId, command);
  },
  sshGetSessions: () => request<SSessionsResult>('/api/ssh/sessions'),
  sshResize: (connectionId, cols, rows) => request<void>(`/api/ssh/${connectionId}/resize`, {
    method: 'POST',
    body: JSON.stringify({ cols, rows }),
  }),
  sshTestConnection: (connection) => request<void>('/api/ssh/test', {
    method: 'POST',
    body: JSON.stringify({ connection }),
  }),
  sshGetHostTrustRecord: (_host, _port) => Promise.resolve({
    success: true,
    data: { record: null as HostTrustRecord | null },
  }),
  onSshData: (callback) => on('ssh-data', callback),
  onSshError: (callback) => on('ssh-error', callback),
  onSshClose: (callback) => on('ssh-close', callback),

  aiChat: (providerId, messages, options) => request<AIChatResult>('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ providerId, messages, options }),
  }),
  aiChatStream: streamWebChat,
  cancelAIChat: (requestId) => request<void>(`/api/ai/cancel/${requestId}`, {
    method: 'POST',
    body: '{}',
  }),
  getAIProviders: () => request<AIProvidersResult<AIProviderSummary>>('/api/ai/providers'),
  saveAIProvider: (provider: AIProviderConfig) => request<void>('/api/ai/providers', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  }),
  setActiveAIProvider: (providerId) => request<void>(`/api/ai/providers/${providerId}/active`, {
    method: 'POST',
    body: '{}',
  }),
  deleteAIProvider: (providerId) => request<void>(`/api/ai/providers/${providerId}`, {
    method: 'DELETE',
  }),
  testAIProvider: (provider) => request<AIChatResult>('/api/ai/test', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  }),
  getAIProviderSecretStatus: (providerId) => request<AIProviderSecretStatusResult>(
    `/api/ai/providers/${providerId}/secret-status`,
  ),

  getConnections: () => request<ConnectionsResult<SSHConnection>>('/api/connections'),
  saveConnection: (connection) => request<void>('/api/connections', {
    method: 'POST',
    body: JSON.stringify({ connection }),
  }),
  deleteConnection: (connectionId) => request<void>(`/api/connections/${connectionId}`, {
    method: 'DELETE',
  }),

  getSettings: () => request<SettingsResult<AppSettings>>('/api/settings'),
  saveSettings: (settings) => request<void>('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ settings }),
  }),

  getCommandHistory: () => request<CommandHistoryResult<CommandHistoryItem>>('/api/command-history'),
  addCommandHistory: (item) => request<void>('/api/command-history', {
    method: 'POST',
    body: JSON.stringify({ item }),
  }),
  clearCommandHistory: () => request<void>('/api/command-history', { method: 'DELETE' }),

  getQuickCommands: () => request<QuickCommandsResult<QuickCommand>>('/api/quick-commands'),
  saveQuickCommand: (command) => request<void>('/api/quick-commands', {
    method: 'POST',
    body: JSON.stringify({ command }),
  }),
  deleteQuickCommand: (commandId) => request<void>(`/api/quick-commands/${commandId}`, {
    method: 'DELETE',
  }),

  getQuickCommandGroups: () => request<QuickCommandGroupsResult<QuickCommandGroup>>('/api/quick-command-groups'),
  saveQuickCommandGroup: (group) => request<void>('/api/quick-command-groups', {
    method: 'POST',
    body: JSON.stringify({ group }),
  }),
  deleteQuickCommandGroup: (groupId) => request<void>(`/api/quick-command-groups/${groupId}`, {
    method: 'DELETE',
  }),

  exportAllData: () => request<ExportDataResult<any>>('/api/export'),
  importData: (data, options) => request<ImportDataResult>(
    `/api/import?merge=${options?.merge === false ? 'false' : 'true'}`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  ),

  selectFile: (options) => chooseFile(options),
  readPrivateKeyFile: (filePath) => readSelectedFile(filePath),

  listDirectory: (connectionId, remotePath) => request<DirectoryListResult<any>>(
    `/api/sftp/${connectionId}/list?path=${encodeURIComponent(remotePath)}`,
  ),
  downloadFile: async (connectionId, remotePath, taskId) => {
    try {
      const response = await fetch(`/api/sftp/${connectionId}/download?path=${encodeURIComponent(remotePath)}`);
      if (!response.ok) {
        return makeError<FileDownloadResult>(await response.text());
      }

      const blob = await response.blob();
      const filename = remotePath.split('/').pop() || 'download';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      emit('sftp-download-progress', { connectionId, taskId, filename, progress: 100 });
      emit('sftp-transfer-complete', {
        connectionId,
        taskId,
        filename,
        transferType: 'download',
        success: true,
      });
      return { success: true, data: { localPath: filename } };
    } catch (error) {
      return makeError<FileDownloadResult>(error instanceof Error ? error.message : String(error));
    }
  },
  uploadFile: async (connectionId, localPath, remoteDir, taskId) => {
    const file = selectedFiles.get(localPath);
    if (!file) {
      return makeError<FileUploadResult>('Selected file is no longer available');
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('remoteDir', remoteDir);
    if (taskId) {
      formData.append('taskId', taskId);
    }

    const result = await request<FileUploadResult>(`/api/sftp/${connectionId}/upload`, {
      method: 'POST',
      body: formData,
    });
    selectedFiles.delete(localPath);
    return result;
  },
  onSftpUploadProgress: (callback) => on('sftp-upload-progress', callback),
  onSftpDownloadProgress: (callback) => on('sftp-download-progress', callback),
  onSftpTransferComplete: (callback) => on('sftp-transfer-complete', callback),

  agentStartTask: (_taskId, connectionId) => request<void>(`/api/agent/${connectionId}/start`, {
    method: 'POST',
    body: '{}',
  }),
  agentStopTask: (connectionId) => request<void>(`/api/agent/${connectionId}/stop`, {
    method: 'POST',
    body: '{}',
  }),
  agentPauseTask: () => Promise.resolve({ success: true }),
  agentResumeTask: () => Promise.resolve({ success: true }),
  agentExecAwait: (connectionId, command, options) => request<AgentExecAwaitResult>(
    `/api/agent/${connectionId}/exec-await`,
    {
      method: 'POST',
      body: JSON.stringify({ command, options }),
    },
  ),
  agentCancelExec: (connectionId) => request<void>(`/api/agent/${connectionId}/cancel-exec`, {
    method: 'POST',
    body: '{}',
  }),
  getAgentTaskHistory: () => request<AgentTaskHistoryResult<AgentTask>>('/api/agent/tasks'),
  saveAgentTaskHistory: (task) => request<void>('/api/agent/tasks', {
    method: 'POST',
    body: JSON.stringify({ task }),
  }),
  clearAgentTaskHistory: () => request<void>('/api/agent/tasks', {
    method: 'DELETE',
  }),
  deleteAgentTaskHistory: (taskId) => request<void>(`/api/agent/tasks/${taskId}`, {
    method: 'DELETE',
  }),
  onAgentTerminalOutput: (callback) => on('agent-terminal-output', callback),

  onSystemResume: (callback) => on('system-resume', callback),
};

export function installWebApi(): void {
  connectEvents();
  window.electronAPI = webApi;
}
