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
  HostTrustPromptEvent,
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
  FileSelectResult,
  ImportDataResult,
  IPCResult,
  PrivateKeyFileResult,
  QuickCommandGroupsResult,
  QuickCommandsResult,
  SettingsResult,
  SftpBatchDeleteResult,
  SftpDownloadDestinationSelectionResult,
  SftpFilesSelectionResult,
  SftpListTransfersResult,
  SftpResolveConflictRequest,
  SftpErrorCode,
  SftpStartDownloadRequest,
  SftpStartTransferResult,
  SftpStartUploadRequest,
  SftpTransferEvent,
  SftpTransferTaskRequest,
  SftpTransferTaskSnapshot,
  SSessionsResult,
  SSHConnectResult,
} from '../../shared/ipc-types';

type ListenerCleanup = () => void;

type EventMap = {
  'ssh-data': { connectionId: string; data: string; type?: string; state?: SSHSessionState };
  'ssh-error': { connectionId: string; error: string };
  'ssh-close': string;
  'ssh-host-trust-prompt': HostTrustPromptEvent;
  'sftp-transfer-event': SftpTransferEvent;
  'agent-terminal-output': { connectionId: string; data: string };
  'system-resume': { timestamp: number };
};

const selectedFiles = new Map<string, File>();
const selectedDirs = new Map<string, FileSystemDirectoryHandle>();
const webSftpTaskSources = new Map<string, string>();
const downloadAbortControllers = new Map<string, AbortController>();
const listeners = new Map<keyof EventMap, Set<(payload: any) => void>>();
const sftpClientId = (() => {
  const key = 'ai-ssh-client.sftp-client-id';
  const existing = window.sessionStorage.getItem(key);
  if (existing) return existing;
  const created = createWebId('web-client');
  window.sessionStorage.setItem(key, created);
  return created;
})();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function makeError<T = void>(message: string, code?: string): IPCResult<T> {
  return { success: false, error: message, code };
}

// 非 secure context 下 crypto.randomUUID 可能不可用
function createWebId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<IPCResult<T>> {
  try {
    // headers 必须在 ...options 之后合并，否则自定义 headers 会丢掉 Content-Type，
    // 导致 express.json 无法解析 body（SFTP 上传/下载表现为 No files selected）。
    const response = await fetch(path, {
      ...options,
      headers: options.body instanceof FormData
        ? options.headers
        : { 'Content-Type': 'application/json', ...options.headers },
    });
    return await response.json();
  } catch (error) {
    return makeError<T>(error instanceof Error ? error.message : String(error));
  }
}

async function sftpRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<IPCResult<T>> {
  return request<T>(path, {
    ...options,
    headers: { 'x-sftp-client-id': sftpClientId, ...options.headers },
  });
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 计算源文件首尾最多 64KiB 的 SHA-256；非安全上下文无 subtle 时退回空指纹。 */
async function hashFileEdges(file: File): Promise<{ head: string; tail: string }> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return { head: '', tail: '' };
  }
  try {
    const edge = 64 * 1024;
    const headSize = Math.min(edge, file.size);
    const tailStart = Math.max(0, file.size - edge);
    const [head, tail] = await Promise.all([
      crypto.subtle.digest('SHA-256', await file.slice(0, headSize).arrayBuffer()),
      crypto.subtle.digest('SHA-256', await file.slice(tailStart).arrayBuffer()),
    ]);
    return { head: toHex(head), tail: toHex(tail) };
  } catch {
    return { head: '', tail: '' };
  }
}

function emitTransferSnapshot(snapshot: SftpTransferTaskSnapshot): void {
  emit('sftp-transfer-event', {
    type: 'snapshot',
    taskId: snapshot.taskId,
    connectionId: snapshot.connectionId,
    attempt: snapshot.attempt,
    sequence: snapshot.sequence,
    timestamp: snapshot.updatedAt,
    snapshot,
  });
}

/** 将 HTTP 返回/本地失败的任务快照推入事件总线，避免只依赖 WebSocket。 */
function publishTaskSnapshot(snapshot: SftpTransferTaskSnapshot): void {
  emitTransferSnapshot(snapshot);
}

/** 流式上传：支持从 checkpoint offset 续传（file.slice）。 */
async function streamSftpUpload(
  taskId: string,
  resumeOffset = 0,
  baselinetask?: SftpTransferTaskSnapshot,
): Promise<IPCResult<{ task: SftpTransferTaskSnapshot }>> {
  const source = webSftpTaskSources.get(taskId);
  const file = source ? selectedFiles.get(source) : undefined;
  if (!file) {
    const failed: SftpTransferTaskSnapshot | null = baselinetask
      ? {
        ...baselinetask,
        status: 'failed',
        error: { code: 'not-found' as SftpErrorCode, message: 'Selected file is no longer available', retryable: false },
        sequence: baselinetask.sequence + 1,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      }
      : null;
    if (failed) publishTaskSnapshot(failed);
    return makeError('Selected file is no longer available', 'not-found');
  }
  const offset = Math.max(0, Math.min(resumeOffset, file.size));
  try {
    // 进入传输中：立即更新 UI，避免长期停在 queued/等待中
    if (baselinetask) {
      publishTaskSnapshot({
        ...baselinetask,
        status: 'transferring',
        resumedFrom: offset,
        transferredBytes: offset,
        sequence: baselinetask.sequence + 1,
        updatedAt: Date.now(),
      });
    }
    const edges = await hashFileEdges(file);
    const response = await fetch(`/api/sftp/transfers/${encodeURIComponent(taskId)}/content`, {
      method: 'PUT',
      headers: {
        'x-sftp-client-id': sftpClientId,
        'content-type': 'application/octet-stream',
        'x-sftp-source-size': String(file.size),
        'x-sftp-source-mtime': String(file.lastModified),
        'x-sftp-source-head': edges.head,
        'x-sftp-source-tail': edges.tail,
        'x-sftp-resume-offset': String(offset),
      },
      body: offset > 0 ? file.slice(offset) : file,
    });
    const result = await response.json() as IPCResult<{ task: SftpTransferTaskSnapshot }>;
    // HTTP 响应里带最终快照时同步到 store（WebSocket 丢失时也能结束任务）
    if (result.success && result.data?.task) {
      publishTaskSnapshot(result.data.task);
    } else if (!result.success && baselinetask) {
      publishTaskSnapshot({
        ...baselinetask,
        status: 'failed',
        error: {
          code: (result.code as SftpErrorCode | undefined) || 'io-error',
          message: result.error || 'Upload failed',
          retryable: true,
        },
        sequence: baselinetask.sequence + 1,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (baselinetask) {
      publishTaskSnapshot({
        ...baselinetask,
        status: 'failed',
        error: { code: 'io-error', message, retryable: true },
        sequence: baselinetask.sequence + 1,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      });
    }
    return makeError(message);
  }
}

/** FSA 目录流式下载：边下边写，支持 Range 续传与 AbortController 取消。 */
async function streamWebDownload(
  task: SftpTransferTaskSnapshot & { downloadUrl?: string },
  dirHandle: FileSystemDirectoryHandle,
): Promise<void> {
  if (!task.downloadUrl) return;
  const controller = new AbortController();
  downloadAbortControllers.set(task.taskId, controller);
  let sequence = task.sequence;
  let snapshot: SftpTransferTaskSnapshot = {
    ...task,
    status: 'transferring',
    updatedAt: Date.now(),
  };
  const push = (patch: Partial<SftpTransferTaskSnapshot>) => {
    sequence += 1;
    snapshot = {
      ...snapshot,
      ...patch,
      sequence,
      updatedAt: Date.now(),
    };
    emitTransferSnapshot(snapshot);
  };

  try {
    push({ status: 'transferring', progress: 0 });
    const fileHandle = await dirHandle.getFileHandle(task.name, { create: true });
    const existing = await fileHandle.getFile().catch(() => null);
    let offset = 0;
    // 简单续传：若本地已有 partial 且小于远端，则 Range 续写。
    if (existing && existing.size > 0) {
      offset = existing.size;
    }
    const writable = await fileHandle.createWritable({ keepExistingData: offset > 0 });
    if (offset > 0) {
      await writable.seek(offset);
    }

    const response = await fetch(task.downloadUrl, {
      signal: controller.signal,
      headers: offset > 0 ? { Range: `bytes=${offset}-` } : undefined,
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(await response.text() || `Download failed (${response.status})`);
    }
    const totalHeader = Number(response.headers.get('content-length') || 0);
    const total = offset > 0 && totalHeader > 0 ? offset + totalHeader : totalHeader || undefined;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Download stream unavailable');
    }

    let transferred = offset;
    push({
      resumedFrom: offset,
      transferredBytes: transferred,
      totalBytes: total,
      progress: total ? Math.min(99, Math.round((transferred / total) * 100)) : 0,
    });

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writable.write(value);
      transferred += value.byteLength;
      push({
        transferredBytes: transferred,
        totalBytes: total,
        progress: total ? Math.min(99, Math.round((transferred / total) * 100)) : 0,
      });
    }
    await writable.close();
    push({
      status: 'completed',
      progress: 100,
      transferredBytes: transferred,
      totalBytes: total || transferred,
      commitGuarantee: 'browser-managed',
      completedAt: Date.now(),
    });
  } catch (error) {
    const canceled = controller.signal.aborted
      || (error instanceof DOMException && error.name === 'AbortError');
    push({
      status: canceled ? 'canceled' : 'failed',
      error: {
        code: canceled ? 'canceled' : 'io-error',
        message: error instanceof Error ? error.message : String(error),
        retryable: !canceled,
      },
      completedAt: Date.now(),
    });
  } finally {
    downloadAbortControllers.delete(task.taskId);
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

  socket.onopen = () => {
    sendSocket('sftp-identify', { clientId: sftpClientId });
  };
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

/** 等待事件 WebSocket 打开，避免连接成功后首包广播无人接收。 */
function ensureEventsConnected(timeoutMs = 3000): Promise<void> {
  connectEvents();
  if (socket?.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (socket?.readyState === WebSocket.OPEN || Date.now() - started >= timeoutMs) {
        resolve();
        return;
      }
      window.setTimeout(tick, 25);
    };
    tick();
  });
}

function sendSocket(type: string, payload: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, ...payload }));
  }
}

/** 按 sessionId 找回连接配置；多会话克隆 id 回退到 connectionId 前缀匹配。 */
async function resolveConnectionConfig(connectionId: string): Promise<SSHConnection | null> {
  const connectionsResult = await request<ConnectionsResult<SSHConnection>>('/api/connections');
  if (!connectionsResult.success) {
    return null;
  }
  const exact = connectionsResult.data.connections.find((item) => item.id === connectionId);
  if (exact) {
    return exact;
  }
  // 形如 `${baseId}-session-${timestamp}` 的克隆会话
  const base = connectionsResult.data.connections.find((item) => (
    connectionId.startsWith(`${item.id}-session-`)
  ));
  return base ? { ...base, id: connectionId } : null;
}

/** 会话丢失时按配置重连，供终端写入与 SFTP 共用。 */
async function ensureSshSession(connectionId: string): Promise<IPCResult> {
  await ensureEventsConnected();
  const sessionsResult = await request<SSessionsResult>('/api/ssh/sessions');
  if (sessionsResult.success) {
    const live = sessionsResult.data.sessions.some((session) => (
      session.connectionId === connectionId && session.isConnected
    ));
    if (live) {
      return { success: true };
    }
  }

  const connection = await resolveConnectionConfig(connectionId);
  if (!connection) {
    return makeError('SSH session is not connected');
  }

  const settingsResult = await request<SettingsResult<AppSettings>>('/api/settings');
  const settings = settingsResult.success ? settingsResult.data.settings : undefined;
  await ensureEventsConnected();
  return request<SSHConnectResult>('/api/ssh/connect', {
    method: 'POST',
    body: JSON.stringify({
      connection,
      cols: 120,
      rows: 32,
      settings,
    }),
  });
}

async function writeSshInput(connectionId: string, command: string): Promise<IPCResult> {
  const result = await request<void>(`/api/ssh/${connectionId}/write`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });

  if (result.success || !result.error?.includes('SSH session is not connected')) {
    return result;
  }

  const connectResult = await ensureSshSession(connectionId);
  if (!connectResult.success) {
    return connectResult;
  }

  return request<void>(`/api/ssh/${connectionId}/write`, {
    method: 'POST',
    body: JSON.stringify({ command }),
  });
}

/** SFTP HTTP 请求：会话掉线时自动重连一次。 */
async function sftpApiRequest<T>(
  connectionId: string,
  path: string,
  options: RequestInit = {},
): Promise<IPCResult<T>> {
  const result = await sftpRequest<T>(path, options);
  if (result.success || !result.error?.includes('SSH session is not connected')) {
    return result;
  }
  const connectResult = await ensureSshSession(connectionId);
  if (!connectResult.success) {
    return connectResult as IPCResult<T>;
  }
  return sftpRequest<T>(path, options);
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

    let settled = false;
    const settle = (result: IPCResult<FileSelectResult>) => {
      if (settled) {
        return;
      }
      settled = true;
      window.removeEventListener('focus', handleWindowFocus);
      input.remove();
      resolve(result);
    };

    // 取消选择时浏览器不一定触发 change，用 focus 兜底
    const handleWindowFocus = () => {
      window.setTimeout(() => {
        if (!settled && !input.files?.length) {
          settle({ success: true, data: { canceled: true, filePath: '', fileName: '' } });
        }
      }, 300);
    };

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        settle({ success: true, data: { canceled: true, filePath: '', fileName: '' } });
        return;
      }

      const id = createWebId('web-file');
      selectedFiles.set(id, file);
      settle({ success: true, data: { canceled: false, filePath: id, fileName: file.name } });
    };
    input.oncancel = () => {
      settle({ success: true, data: { canceled: true, filePath: '', fileName: '' } });
    };

    window.addEventListener('focus', handleWindowFocus);
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
  sshConnect: async (connection, cols, rows, settings) => {
    // 先确保 WS 就绪，再握手，减少 MOTD/提示符丢失
    await ensureEventsConnected();
    return request<SSHConnectResult>('/api/ssh/connect', {
      method: 'POST',
      body: JSON.stringify({ connection, cols, rows, settings }),
    });
  },
  sshDisconnect: (connectionId) => request<void>(`/api/ssh/${connectionId}/disconnect`, {
    method: 'POST',
    body: '{}',
  }),
  sshExecute: (connectionId, command) => writeSshInput(connectionId, command),
  sshExecuteSync: (connectionId, command) => {
    void writeSshInput(connectionId, command);
  },
  sshGetSessions: () => request<SSessionsResult>('/api/ssh/sessions'),
  sshGetOutputBuffer: (connectionId) => request<import('../../shared/ipc-types').SshOutputBufferResult>(
    `/api/ssh/${encodeURIComponent(connectionId)}/output-buffer`,
  ),
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
  sshListHostTrustRecords: () => Promise.resolve({
    success: true,
    data: { records: [] as HostTrustRecord[] },
  }),
  sshUpsertHostTrustRecord: async () => ({ success: true }),
  sshDeleteHostTrustRecord: async () => ({ success: true }),
  sshClearHostTrustRecords: async () => ({ success: true }),
  sshRespondHostTrust: async () => ({ success: true }),
  onSshData: (callback) => on('ssh-data', callback),
  onSshError: (callback) => on('ssh-error', callback),
  onSshClose: (callback) => on('ssh-close', callback),
  onSshHostTrustPrompt: (callback) => on('ssh-host-trust-prompt', callback),

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
  reorderConnections: (connectionIds) => request<void>('/api/connections/order', {
    method: 'PUT',
    body: JSON.stringify({ connectionIds }),
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

  exportAllData: (options) => request<ExportDataResult<any>>(
    `/api/export?includeSecrets=${options?.includeSecrets === false ? 'false' : 'true'}`,
  ),
  importData: (data, options) => request<ImportDataResult>(
    `/api/import?merge=${options?.merge === false ? 'false' : 'true'}`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    },
  ),

  selectFile: (options) => chooseFile(options),
  readPrivateKeyFile: (filePath) => readSelectedFile(filePath),

  listDirectory: (connectionId, remotePath) => sftpApiRequest<DirectoryListResult>(
    connectionId,
    `/api/sftp/${connectionId}/list?path=${encodeURIComponent(remotePath)}`,
  ),
  selectSftpFiles: () => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const settle = (result: IPCResult<SftpFilesSelectionResult>) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(result);
    };
    input.onchange = () => {
      const files = Array.from(input.files || []);
      const refs = files.map((file) => {
        const ref = createWebId('web-file');
        selectedFiles.set(ref, file);
        return {
          name: file.name,
          ref,
          size: file.size,
          lastModified: file.lastModified,
        };
      });
      settle({ success: true, data: { canceled: refs.length === 0, files: refs } });
    };
    input.oncancel = () => settle({ success: true, data: { canceled: true, files: [] } });
    document.body.appendChild(input);
    input.click();
  }),
  // 优先 FSA 选目录做流式落盘；不支持时回退浏览器下载管理器。
  selectSftpDownloadDestination: async () => {
    const picker = (window as Window & {
      showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (typeof picker === 'function') {
      try {
        const dir = await picker({ mode: 'readwrite' });
        const ref = createWebId('web-dir');
        selectedDirs.set(ref, dir);
        return {
          success: true as const,
          data: { canceled: false, destination: { ref, name: dir.name } },
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return { success: true as const, data: { canceled: true } };
        }
        // 权限/策略失败时继续回退。
      }
    }
    return {
      success: true as const,
      data: { canceled: false, destination: { name: 'browser-download' } },
    };
  },
  /** 注册拖放/粘贴的浏览器 File，供后续流式上传复用。 */
  prepareSftpLocalFiles: (files: File[]) => {
    const prepared = files
      .filter((file) => file && file.name && !file.name.includes('/') && !file.name.includes('\\'))
      .map((file) => {
        const ref = createWebId('web-file');
        selectedFiles.set(ref, file);
        return {
          name: file.name,
          ref,
          size: file.size,
          lastModified: file.lastModified,
        };
      });
    if (prepared.length === 0) {
      return makeError<SftpFilesSelectionResult>('No uploadable files in drop payload', 'invalid-path');
    }
    return { success: true, data: { canceled: false, files: prepared } };
  },
  createSftpDirectory: (connectionId, remotePath) => sftpApiRequest<void>(
    connectionId,
    `/api/sftp/${connectionId}/directory`,
    { method: 'POST', body: JSON.stringify({ remotePath }) },
  ),
  setSftpPermissions: (connectionId, remotePath, mode) => sftpApiRequest<void>(
    connectionId,
    `/api/sftp/${connectionId}/permissions`,
    { method: 'POST', body: JSON.stringify({ remotePath, mode }) },
  ),
  readSftpTextFile: (connectionId, remotePath) => sftpApiRequest<import('../../shared/ipc-types').SftpTextFileContent>(
    connectionId,
    `/api/sftp/${connectionId}/text?path=${encodeURIComponent(remotePath)}`,
  ),
  writeSftpTextFile: (connectionId, remotePath, content) => sftpApiRequest<void>(
    connectionId,
    `/api/sftp/${connectionId}/text`,
    { method: 'PUT', body: JSON.stringify({ remotePath, content }) },
  ),
  deleteSftpItems: (connectionId, remotePaths) => sftpApiRequest<SftpBatchDeleteResult>(
    connectionId,
    `/api/sftp/${connectionId}/items`,
    { method: 'DELETE', body: JSON.stringify({ remotePaths }) },
  ),
  startSftpUpload: async (request: SftpStartUploadRequest) => {
    const ensured = await ensureSshSession(request.connectionId);
    if (!ensured.success) return ensured as IPCResult<SftpStartTransferResult>;
    // 上传前确保事件通道已建立，便于服务端进度推送
    connectEvents();
    const created = await sftpRequest<SftpStartTransferResult>('/api/sftp/transfers/upload', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (!created.success) return created;
    created.data.tasks.forEach((task, index) => {
      // 优先按下标绑定，避免同名文件匹配错位导致永不推流
      const source = request.files[index]?.ref
        || request.files.find((file) => file.name === task.name)?.ref;
      if (!source) {
        publishTaskSnapshot({
          ...task,
          status: 'failed',
          error: {
            code: 'not-found',
            message: 'Upload source file is missing',
            retryable: false,
          },
          sequence: task.sequence + 1,
          updatedAt: Date.now(),
          completedAt: Date.now(),
        });
        return;
      }
      webSftpTaskSources.set(task.taskId, source);
      void streamSftpUpload(task.taskId, 0, task);
    });
    return created;
  },
  startSftpDownload: async (request: SftpStartDownloadRequest) => {
    const ensured = await ensureSshSession(request.connectionId);
    if (!ensured.success) {
      return ensured as IPCResult<SftpStartTransferResult & {
        tasks: Array<SftpTransferTaskSnapshot & { downloadUrl?: string }>;
      }>;
    }
    const result = await sftpRequest<SftpStartTransferResult & {
      tasks: Array<SftpTransferTaskSnapshot & { downloadUrl?: string }>;
    }>(
      '/api/sftp/transfers/download',
      { method: 'POST', body: JSON.stringify(request) },
    );
    if (!result.success) return result;
    const dirRef = request.destination?.ref;
    const dirHandle = dirRef ? selectedDirs.get(dirRef) : undefined;
    if (dirHandle) {
      // FSA：并行启动流式下载（各任务独立 AbortController）。
      result.data.tasks.forEach((task) => {
        void streamWebDownload(task, dirHandle);
      });
      return result;
    }
    // handed-off：串行触发浏览器原生下载。
    for (const task of result.data.tasks) {
      if (!task.downloadUrl) continue;
      const anchor = document.createElement('a');
      anchor.href = task.downloadUrl;
      anchor.download = task.name;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }
    return result;
  },
  resolveSftpConflict: async (request: SftpResolveConflictRequest) => {
    const result = await sftpRequest<void>(
      `/api/sftp/transfers/${encodeURIComponent(request.taskId)}/conflict`,
      { method: 'POST', body: JSON.stringify(request) },
    );
    if (result.success) {
      // 当前任务及批次同伴在策略确定后重新推送内容流。
      const taskIds = request.applyToBatch
        ? [...webSftpTaskSources.keys()]
        : [request.taskId];
      taskIds.forEach((taskId) => {
        if (webSftpTaskSources.has(taskId)) {
          void streamSftpUpload(taskId, 0);
        }
      });
    }
    return result;
  },
  cancelSftpTransfer: async (request: SftpTransferTaskRequest) => {
    downloadAbortControllers.get(request.taskId)?.abort();
    return sftpRequest<void>(
      `/api/sftp/transfers/${encodeURIComponent(request.taskId)}/cancel`,
      { method: 'POST', body: '{}' },
    );
  },
  retrySftpTransfer: async (request: SftpTransferTaskRequest) => {
    const result = await sftpRequest<SftpTransferTaskSnapshot>(
      `/api/sftp/transfers/${encodeURIComponent(request.taskId)}/retry`,
      { method: 'POST', body: '{}' },
    );
    if (result.success && result.data.direction === 'upload') {
      void streamSftpUpload(request.taskId, result.data.resumedFrom || 0, result.data);
    }
    return result;
  },
  discardSftpTransfer: async (request: SftpTransferTaskRequest) => {
    const result = await sftpRequest<void>(
      `/api/sftp/transfers/${encodeURIComponent(request.taskId)}`,
      { method: 'DELETE' },
    );
    if (result.success) {
      const source = webSftpTaskSources.get(request.taskId);
      if (source) selectedFiles.delete(source);
      webSftpTaskSources.delete(request.taskId);
    }
    return result;
  },
  listSftpTransfers: (connectionId?: string) => sftpRequest<SftpListTransfersResult>(
    `/api/sftp/transfers${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`,
  ),
  onSftpTransferEvent: (callback) => on('sftp-transfer-event', callback),
  renameItem: (connectionId, remotePath, newName) => sftpApiRequest<void>(
    connectionId,
    `/api/sftp/${connectionId}/rename`,
    {
      method: 'POST',
      body: JSON.stringify({ remotePath, newName }),
    },
  ),
  deleteItem: (connectionId, remotePath) => sftpApiRequest<void>(
    connectionId,
    `/api/sftp/${connectionId}/item`,
    {
      method: 'DELETE',
      body: JSON.stringify({ remotePath }),
    },
  ),
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
