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
  McpConfigSaveResult,
  McpConfigSnapshot,
  McpPolicyConfig,
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
import { t } from '../i18n';
import { createAsyncTaskQueue } from '../transfer/async-task-queue';
import {
  decideWebDownloadConflict,
  decideWebDownloadResume,
  localNameWithSuffix,
  suggestedLocalName,
  webDownloadPartMetaName,
} from './web-download-resume';
import type { WebDownloadPartMeta } from './web-download-resume';

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

/** FSA 流式下载的上下文：重试时据此重新发起 streamWebDownload。 */
interface WebDownloadContext {
  dirHandle: FileSystemDirectoryHandle;
  downloadUrl: string;
  conflictPolicy: SftpTransferTaskSnapshot['conflictPolicy'];
}
const webSftpDownloadContexts = new Map<string, WebDownloadContext>();

/** 等待用户裁决的本地下载冲突（按 taskId 索引），由 resolveSftpConflict 拦截唤醒。 */
interface PendingWebDownloadConflict {
  resolve: (resolution: { policy: 'overwrite' | 'skip' | 'rename'; renamedPath?: string }) => void;
  reject: (error: unknown) => void;
}
const webDownloadConflictResolvers = new Map<string, PendingWebDownloadConflict>();
/** 浏览器上行与 SSH/SFTP 共用带宽；限制并发，避免大文件批量上传拖死页面。 */
const WEB_UPLOAD_CONCURRENCY = 1;
const webUploadQueue = createAsyncTaskQueue<unknown>(WEB_UPLOAD_CONCURRENCY);
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
    // x-ssh-client-id：SSH 会话按标签页隔离，避免多客户端共享同一 shell 互相串命令。
    const response = await fetch(path, {
      ...options,
      headers: options.body instanceof FormData
        ? options.headers
        : {
            'Content-Type': 'application/json',
            'x-ssh-client-id': sftpClientId,
            ...options.headers,
          },
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

/**
 * 冲突响应可能先于 WebSocket 建连而丢失 waiting-conflict 事件。
 * 通过任务列表补拉一次，确保 UI 能进入冲突处理状态而不是停在“传输中”。
 */
async function refreshWebTransferTask(taskId: string): Promise<void> {
  const result = await sftpRequest<SftpListTransfersResult>('/api/sftp/transfers');
  if (!result.success) return;
  const snapshot = result.data.tasks.find((task) => task.taskId === taskId);
  if (snapshot) publishTaskSnapshot(snapshot);
}

/** 单次 PUT 分片大小：避免整文件超 Node/代理超时（默认 5 分钟约只能传到数百 MB）。 */
const WEB_UPLOAD_CHUNK_BYTES = 32 * 1024 * 1024;

/** 发布上传失败快照（保留已传字节便于 UI/重试）。 */
function publishUploadFailure(
  baselinetask: SftpTransferTaskSnapshot | undefined,
  message: string,
  code: SftpErrorCode = 'io-error',
  transferredBytes?: number,
): void {
  if (!baselinetask) {
    return;
  }
  publishTaskSnapshot({
    ...baselinetask,
    status: 'failed',
    transferredBytes: transferredBytes ?? baselinetask.transferredBytes,
    error: { code, message, retryable: code !== 'not-found' },
    sequence: baselinetask.sequence + 1,
    updatedAt: Date.now(),
    completedAt: Date.now(),
  });
}

/** 流式分片上传：按 32MiB 切片 PUT，支持 checkpoint offset 续传。 */
async function streamSftpUpload(
  taskId: string,
  resumeOffset = 0,
  baselinetask?: SftpTransferTaskSnapshot,
): Promise<IPCResult<{ task: SftpTransferTaskSnapshot }>> {
  const source = webSftpTaskSources.get(taskId);
  const file = source ? selectedFiles.get(source) : undefined;
  if (!file) {
    publishUploadFailure(baselinetask, 'Selected file is no longer available', 'not-found');
    return makeError('Selected file is no longer available', 'not-found');
  }

  let offset = Math.max(0, Math.min(resumeOffset, file.size));
  let latestTask = baselinetask;
  try {
    // 进入传输中：立即更新 UI，避免长期停在 queued/等待中
    if (baselinetask) {
      latestTask = {
        ...baselinetask,
        status: 'transferring',
        resumedFrom: offset,
        transferredBytes: offset,
        sequence: baselinetask.sequence + 1,
        updatedAt: Date.now(),
      };
      publishTaskSnapshot(latestTask);
    }

    const edges = await hashFileEdges(file);

    // 空文件也要走一轮 complete=1，触发远端创建
    do {
      const chunkStart = offset;
      const end = file.size === 0
        ? 0
        : Math.min(offset + WEB_UPLOAD_CHUNK_BYTES, file.size);
      const isComplete = end >= file.size;
      const body = file.size === 0 ? new Blob([]) : file.slice(offset, end);

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
          'x-sftp-upload-complete': isComplete ? '1' : '0',
        },
        body,
      });
      const result = await response.json() as IPCResult<{ task: SftpTransferTaskSnapshot }>;

      if (!result.success) {
        // 服务端认为客户端声明的续传起点超过其可确认偏移：按服务端确认偏移重传该片，
        // 绝不能把“从 claimedOffset 切片的尾巴”当作已完成的剩余内容。
        if (result.code === 'resume-offset-reset') {
          const confirmed = Number(
            (result as { confirmedOffset?: number }).confirmedOffset
              ?? result.task?.resumedFrom
              ?? 0,
          );
          const nextOffset = Number.isFinite(confirmed) ? Math.max(0, confirmed) : 0;
          if (nextOffset < offset) {
            offset = nextOffset;
            if (result.task) publishTaskSnapshot(result.task);
            continue;
          }
          publishUploadFailure(
            latestTask || baselinetask,
            result.error || 'Server reset the resume offset',
            'io-error',
            offset,
          );
          return makeError(result.error || 'Server reset the resume offset', 'io-error');
        }
        // 冲突响应优先使用服务端快照；若旧网关没有携带快照，再补拉任务列表。
        if (result.code === 'conflict' || response.status === 409) {
          if (result.task) {
            publishTaskSnapshot(result.task);
          } else {
            await refreshWebTransferTask(taskId);
          }
          return makeError(result.error || 'Destination already exists', 'conflict');
        }
        publishUploadFailure(
          latestTask || baselinetask,
          result.error || `Upload failed (${response.status})`,
          (result.code as SftpErrorCode | undefined) || 'io-error',
          offset,
        );
        return result;
      }
      if (!result.data?.task) {
        publishUploadFailure(
          latestTask || baselinetask,
          `Upload failed (${response.status})`,
          'io-error',
          offset,
        );
        return makeError(`Upload failed (${response.status})`, 'io-error');
      }

      latestTask = result.data.task;
      publishTaskSnapshot(latestTask);
      // 以服务端确认偏移为准。注意不能用 Math.max 抬高：服务端可能因 checkpoint
      // 校正而把偏移向下修正，此时必须采用服务端的较小值，否则会跳字节。
      const serverBytes = Number(latestTask.transferredBytes);
      offset = Number.isFinite(serverBytes) && serverBytes >= 0 ? serverBytes : end;

      if (isComplete || latestTask.status === 'completed' || latestTask.status === 'skipped') {
        return { success: true, data: { task: latestTask } };
      }
      if (latestTask.status === 'waiting-conflict') {
        return { success: true, data: { task: latestTask } };
      }
      if (latestTask.status === 'failed' || latestTask.status === 'canceled') {
        return { success: true, data: { task: latestTask } };
      }
      // 防御：本片结束后偏移未推进则避免死循环
      if (file.size > 0 && offset <= chunkStart) {
        publishUploadFailure(latestTask, 'Upload offset did not advance', 'io-error', offset);
        return makeError('Upload offset did not advance', 'io-error');
      }
    } while (offset < file.size);

    return latestTask
      ? { success: true, data: { task: latestTask } }
      : makeError('Upload finished without task snapshot');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    publishUploadFailure(latestTask || baselinetask, message, 'io-error', offset);
    return makeError(message);
  }
}

/** 将上传任务放入受控队列，避免同一批次的大文件同时占满上行。 */
function enqueueWebUpload(
  taskId: string,
  resumeOffset = 0,
  baselineTask?: SftpTransferTaskSnapshot,
): void {
  webUploadQueue.enqueue({
    key: taskId,
    run: () => streamSftpUpload(taskId, resumeOffset, baselineTask),
  });
}

/** 下载 checkpoint 刷新节奏：已写字节或时间任一达到即刷新，中断后最多丢一小段。 */
const WEB_DOWNLOAD_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const WEB_DOWNLOAD_CHECKPOINT_MS = 2000;

/** 读取任务专属下载 checkpoint；不存在或损坏时返回 null（视为不可续传）。 */
async function readWebDownloadPartMeta(
  dirHandle: FileSystemDirectoryHandle,
  metaName: string,
): Promise<WebDownloadPartMeta | null> {
  try {
    const handle = await dirHandle.getFileHandle(metaName);
    const file = await handle.getFile();
    const parsed = JSON.parse(await file.text()) as Partial<WebDownloadPartMeta>;
    if (
      typeof parsed.taskId === 'string'
      && typeof parsed.name === 'string'
      && typeof parsed.etag === 'string'
      && typeof parsed.size === 'number'
      && typeof parsed.bytesWritten === 'number'
    ) {
      return parsed as WebDownloadPartMeta;
    }
    return null;
  } catch {
    return null;
  }
}

/** 写入/刷新下载 checkpoint（best-effort：失败只影响续传，不影响本次下载）。 */
async function writeWebDownloadPartMeta(
  dirHandle: FileSystemDirectoryHandle,
  metaName: string,
  meta: WebDownloadPartMeta,
): Promise<void> {
  try {
    const handle = await dirHandle.getFileHandle(metaName, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    await writable.write(JSON.stringify(meta));
    await writable.close();
  } catch {
    // checkpoint 只是加速续传的辅助数据，写失败不应中断下载。
  }
}

/** 下载成功后删除 checkpoint。 */
async function deleteWebDownloadPartMeta(
  dirHandle: FileSystemDirectoryHandle,
  metaName: string,
): Promise<void> {
  try {
    await dirHandle.removeEntry(metaName);
  } catch {
    // 已不存在或被浏览器拒绝时忽略。
  }
}

/**
 * 把 FSA 流式下载的进度/终态回报给服务端，让任务记录不再永远停在 queued（可重试）。
 * 本地 emit 仍是 UI 真相来源；回报失败只记日志，不能中断正在进行的下载。
 */
async function reportWebSftpDownloadStatus(
  taskId: string,
  update: {
    attempt: number;
    status: 'transferring' | 'completed' | 'failed' | 'canceled' | 'skipped';
    transferredBytes?: number;
    totalBytes?: number;
    error?: { code?: string; message?: string; retryable?: boolean };
  },
): Promise<void> {
  const result = await sftpRequest<{ task: SftpTransferTaskSnapshot }>(
    `/api/sftp/transfers/${encodeURIComponent(taskId)}/download-status`,
    { method: 'PUT', body: JSON.stringify(update) },
  );
  if (!result.success) {
    console.warn('[web] failed to report download status', taskId, result.error);
  }
}

/** 目标目录里是否已存在同名条目（不创建）。 */
async function localNameExists(
  dirHandle: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** 从 name 开始找一个不存在的文件名：`base (1).ext`、`base (2).ext`…… */
async function findAvailableLocalName(
  dirHandle: FileSystemDirectoryHandle,
  name: string,
): Promise<string> {
  if (!(await localNameExists(dirHandle, name))) return name;
  for (let index = 1; index < 10000; index += 1) {
    const candidate = localNameWithSuffix(name, index);
    if (!(await localNameExists(dirHandle, candidate))) return candidate;
  }
  throw new Error('Unable to find an available local filename');
}

/**
 * 等待用户对本地下载冲突做出裁决；取消（AbortController）时以 AbortError 退出，
 * 让上层统一走 canceled 分支。
 */
function waitForWebDownloadConflict(
  taskId: string,
  signal: AbortSignal,
): Promise<{ policy: 'overwrite' | 'skip' | 'rename'; renamedPath?: string }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const cleanup = () => {
      webDownloadConflictResolvers.delete(taskId);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    webDownloadConflictResolvers.set(taskId, {
      resolve: (resolution) => {
        cleanup();
        resolve(resolution);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
  });
}

/** FSA 目录流式下载：边下边写，支持 Range 续传、冲突策略与 AbortController 取消。 */
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

  // 目标名可能因冲突改名，checkpoint 文件名随之变化。
  let targetName = task.name;
  let metaName = webDownloadPartMetaName(targetName, task.taskId);
  let writable: FileSystemWritableFileStream | undefined;
  let metaInfo: WebDownloadPartMeta | null = null;
  let transferred = 0;
  const policy = task.conflictPolicy || 'ask';
  const report = (
    status: 'transferring' | 'completed' | 'failed' | 'canceled' | 'skipped',
    extra: {
      transferredBytes?: number;
      totalBytes?: number;
      error?: { code?: string; message?: string; retryable?: boolean };
    } = {},
  ) => {
    void reportWebSftpDownloadStatus(task.taskId, { attempt: task.attempt, status, ...extra });
  };

  try {
    push({ status: 'transferring', progress: 0 });
    report('transferring', { transferredBytes: 0, totalBytes: task.totalBytes });

    // 先探测目标文件是否存在，但绝不在此处创建它（避免因探测而“制造”冲突）。
    let existingHandle: FileSystemFileHandle | null = null;
    try {
      existingHandle = await dirHandle.getFileHandle(task.name);
    } catch {
      existingHandle = null;
    }
    let existingSize = 0;
    if (existingHandle) {
      const existingFile = await existingHandle.getFile().catch(() => null);
      existingSize = existingFile?.size ?? 0;
    }

    // 只有存在“本任务专属”的 checkpoint 且与本地文件大小匹配时才尝试续传，
    // 否则按冲突策略处理——绝不把新内容追加到无关的同名旧文件后面。
    const metadata = await readWebDownloadPartMeta(dirHandle, metaName);
    const resumeDecision = decideWebDownloadResume({
      taskId: task.taskId,
      metadata,
      existingSize,
    });

    let action = decideWebDownloadConflict({
      exists: existingHandle != null,
      resume: resumeDecision.resume,
      policy,
    });

    if (action === 'ask') {
      // 本地同名文件无法续传：复用统一冲突弹窗裁决，等待 resolveSftpConflict 拦截唤醒。
      push({
        status: 'waiting-conflict',
        conflict: {
          sourcePath: task.remotePath || task.name,
          destinationPath: task.name,
          suggestedName: suggestedLocalName(task.name),
        },
      });
      const resolution = await waitForWebDownloadConflict(task.taskId, controller.signal);
      action = resolution.policy;
      if (resolution.policy === 'rename') {
        targetName = await findAvailableLocalName(
          dirHandle,
          resolution.renamedPath?.trim() || task.name,
        );
      }
    } else if (action === 'rename') {
      targetName = await findAvailableLocalName(dirHandle, task.name);
    }

    if (action === 'skip') {
      // 保留本地原文件，任务记为跳过并回报服务端。
      push({
        status: 'skipped',
        progress: 0,
        transferredBytes: 0,
        commitGuarantee: 'browser-managed',
        completedAt: Date.now(),
      });
      report('skipped', { transferredBytes: 0, totalBytes: task.totalBytes });
      return;
    }

    if (targetName !== task.name) {
      metaName = webDownloadPartMetaName(targetName, task.taskId);
    }

    const requestHeaders: Record<string, string> = {};
    if (action === 'resume') {
      requestHeaders.Range = `bytes=${resumeDecision.offset}-`;
      if (resumeDecision.ifRange) requestHeaders['If-Range'] = resumeDecision.ifRange;
    }

    const response = await fetch(task.downloadUrl, {
      signal: controller.signal,
      headers: action === 'resume' ? requestHeaders : undefined,
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(await response.text() || `Download failed (${response.status})`);
    }
    const responseEtag = response.headers.get('etag') || '';
    // 只有 206 且响应校验器与 checkpoint 一致才算续传成功；200/416 都视为
    // 服务端要求重下（例如 If-Range 校验失败），从 0 覆盖旧文件。
    const confirmedResume = action === 'resume'
      && response.status === 206
      && (!responseEtag || !metadata?.etag || responseEtag === metadata.etag);
    const offset = confirmedResume ? Math.min(resumeDecision.offset, existingSize) : 0;

    const contentLength = Number(response.headers.get('content-length') || 0);
    const total = offset > 0 && contentLength > 0 ? offset + contentLength : contentLength || undefined;
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Download stream unavailable');
    }

    const fileHandle = await dirHandle.getFileHandle(targetName, { create: true });
    writable = await fileHandle.createWritable({ keepExistingData: offset > 0 });
    if (offset > 0) {
      await writable.seek(offset);
    }
    metaInfo = {
      taskId: task.taskId,
      name: targetName,
      etag: responseEtag || metadata?.etag || '',
      size: total ?? 0,
      bytesWritten: offset,
    };
    await writeWebDownloadPartMeta(dirHandle, metaName, metaInfo);

    transferred = offset;
    let lastMetaBytes = offset;
    let lastMetaAt = Date.now();
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
      if (
        transferred - lastMetaBytes >= WEB_DOWNLOAD_CHECKPOINT_BYTES
        || Date.now() - lastMetaAt >= WEB_DOWNLOAD_CHECKPOINT_MS
      ) {
        lastMetaBytes = transferred;
        lastMetaAt = Date.now();
        await writeWebDownloadPartMeta(dirHandle, metaName, {
          ...metaInfo,
          size: total ?? metaInfo.size,
          bytesWritten: transferred,
        });
      }
    }
    await writable.close();
    writable = undefined;
    await deleteWebDownloadPartMeta(dirHandle, metaName);
    push({
      status: 'completed',
      progress: 100,
      transferredBytes: transferred,
      totalBytes: total || transferred,
      commitGuarantee: 'browser-managed',
      completedAt: Date.now(),
    });
    report('completed', { transferredBytes: transferred, totalBytes: total || transferred });
    // 成功后清理重试上下文；失败/取消保留以便重试。
    webSftpDownloadContexts.delete(task.taskId);
  } catch (error) {
    const canceled = controller.signal.aborted
      || (error instanceof DOMException && error.name === 'AbortError');
    // 中断时尽量把已写字节提交并刷新 checkpoint，便于下次续传；失败不遮挡原始错误。
    if (writable) {
      await writable.close().catch(() => undefined);
      writable = undefined;
    }
    if (metaInfo && transferred > 0) {
      await writeWebDownloadPartMeta(dirHandle, metaName, {
        ...metaInfo,
        bytesWritten: transferred,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    push({
      status: canceled ? 'canceled' : 'failed',
      error: {
        code: canceled ? 'canceled' : 'io-error',
        message,
        retryable: !canceled,
      },
      completedAt: Date.now(),
    });
    report(canceled ? 'canceled' : 'failed', {
      transferredBytes: transferred,
      totalBytes: metaInfo?.size || task.totalBytes,
      error: canceled ? undefined : { code: 'io-error', message, retryable: true },
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
    sendSocket('sftp-identify', { clientId: sftpClientId, sshClientId: sftpClientId });
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

/**
 * 关闭/刷新标签页时尽力通知服务端提前清理会话。
 * sendBeacon 无法带自定义 header，clientId 走 query；鉴权依赖同源 Cookie。
 * 服务端只缩短清理宽限期（5s）：F5 刷新重挂秒级重连可取消，不丢 vim 现场；
 * 真关闭则 5s 后释放，避免幽灵 vim 占文件。
 */
function registerPageHideCleanup(): void {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    return;
  }
  window.addEventListener('pagehide', () => {
    try {
      navigator.sendBeacon(`/api/ssh/cleanup?clientId=${encodeURIComponent(sftpClientId)}`);
    } catch {
      // 页面正在卸载，失败无妨：服务端 20s 宽限期兜底
    }
  });
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

/** 经事件 WS 写 SSH 输入；未连通时返回 false，由调用方 HTTP 兜底。 */
function tryWriteSshViaSocket(connectionId: string, data: string): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  // 与 server ssh-write 约定一致：低延迟保序，供 xterm 查询应答（CPR/DA/OSC）
  try {
    socket.send(JSON.stringify({
      type: 'ssh-write',
      connectionId,
      data,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * 经事件 WS 发送 resize；未连通时返回 false，由调用方 HTTP 兜底。
 * resize 必须保序：首次 fit 会连发多次尺寸，HTTP POST 无顺序保证，
 * 旧尺寸后到会覆盖新尺寸且不再有后续 SIGWINCH → vim 按错误行列绘制（底部缺行）。
 */
function tryResizeSshViaSocket(connectionId: string, cols: number, rows: number): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify({
      type: 'ssh-resize',
      connectionId,
      cols,
      rows,
    }));
    return true;
  } catch {
    return false;
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

/** SSH 连接 HTTP 请求超时：远端 TCP 黑洞（SYN 无应答）时 fetch 可挂起数分钟，
 * 前端状态机停在"重新连接中"无法推进，必须主动 abort 进入下一轮重试。 */
const SSH_CONNECT_HTTP_TIMEOUT_MS = 25000;

async function requestSshConnect(
  connection: SSHConnection,
  cols?: number,
  rows?: number,
  settings?: AppSettings,
): Promise<IPCResult<SSHConnectResult>> {
  await ensureEventsConnected();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SSH_CONNECT_HTTP_TIMEOUT_MS);
  try {
    return await request<SSHConnectResult>('/api/ssh/connect', {
      method: 'POST',
      body: JSON.stringify({ connection, cols, rows, settings }),
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
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
  return requestSshConnect(connection, 120, 32, settings);
}

async function writeSshInput(connectionId: string, command: string): Promise<IPCResult> {
  // 优先 WS：终端按键与 xterm 查询应答必须低延迟、保序
  if (tryWriteSshViaSocket(connectionId, command)) {
    return { success: true };
  }

  // WS 短暂未就绪时先拉起再写，避免整段输入退化到 HTTP
  await ensureEventsConnected(800);
  if (tryWriteSshViaSocket(connectionId, command)) {
    return { success: true };
  }

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

  if (tryWriteSshViaSocket(connectionId, command)) {
    return { success: true };
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
    // 先确保 WS 就绪再握手，减少 MOTD/提示符丢失；requestSshConnect 内含超时兜底
    return requestSshConnect(connection, cols, rows, settings);
  },
  sshDisconnect: (connectionId) => request<void>(`/api/ssh/${connectionId}/disconnect`, {
    method: 'POST',
    body: '{}',
  }),
  sshExecute: (connectionId, command) => writeSshInput(connectionId, command),
  // 同步路径：WS 可写则立即发送，避免 HTTP 竞态打乱 CSI/OSC 应答
  sshExecuteSync: (connectionId, command) => {
    try {
      if (tryWriteSshViaSocket(connectionId, command)) {
        return;
      }
    } catch {
      // WS send 异常时走 HTTP 兜底，避免按键被静默吞掉
    }
    void writeSshInput(connectionId, command);
  },
  sshGetSessions: () => request<SSessionsResult>('/api/ssh/sessions'),
  sshGetOutputBuffer: (connectionId) => request<import('../../shared/ipc-types').SshOutputBufferResult>(
    `/api/ssh/${encodeURIComponent(connectionId)}/output-buffer`,
  ),
  // 交互 shell 真实 PWD，供终端右键打开传输（SFTP 家目录无法反映 cd）
  sshProbePwd: (connectionId) => request<{ cwd: string }>(
    `/api/ssh/${encodeURIComponent(connectionId)}/pwd`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  ),
  sshResize: (connectionId, cols, rows) => {
    // 优先走 WS 有序通道；WS 未就绪时回退 HTTP（server 两端等价处理）
    if (tryResizeSshViaSocket(connectionId, cols, rows)) {
      return Promise.resolve({ success: true } as IPCResult<void>);
    }
    return request<void>(`/api/ssh/${connectionId}/resize`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    });
  },
  sshTestConnection: (connection) => request<void>('/api/ssh/test', {
    method: 'POST',
    body: JSON.stringify({ connection }),
  }),
  sshGetHostTrustRecord: (host, port) => request<{ record: HostTrustRecord | null }>(
    `/api/ssh/host-trust/record?host=${encodeURIComponent(host)}&port=${encodeURIComponent(String(port))}`,
  ),
  sshListHostTrustRecords: () => request<{ records: HostTrustRecord[] }>('/api/ssh/host-trust'),
  sshUpsertHostTrustRecord: (record) => request<void>('/api/ssh/host-trust', {
    method: 'POST',
    body: JSON.stringify({ record }),
  }),
  sshDeleteHostTrustRecord: (host, port) => request<void>(
    `/api/ssh/host-trust?host=${encodeURIComponent(host)}&port=${encodeURIComponent(String(port))}`,
    { method: 'DELETE' },
  ),
  sshClearHostTrustRecords: () => request<void>('/api/ssh/host-trust/clear', {
    method: 'POST',
    body: '{}',
  }),
  sshRespondHostTrust: (requestId, accepted) => request<void>(
    '/api/ssh/host-trust/respond',
    {
      method: 'POST',
      body: JSON.stringify({ requestId, accepted }),
    },
  ),
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
      enqueueWebUpload(task.taskId, 0, task);
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
      result.data.tasks.forEach((task: SftpTransferTaskSnapshot & { downloadUrl?: string }) => {
        if (task.downloadUrl) {
          webSftpDownloadContexts.set(task.taskId, {
            dirHandle,
            downloadUrl: task.downloadUrl,
            conflictPolicy: task.conflictPolicy,
          });
        }
        void streamWebDownload(task, dirHandle);
      });
      return result;
    }
    // handed-off：串行触发浏览器原生下载。
    // 注意：http://<局域网IP> 属于非安全上下文，Chrome 会把非白名单扩展名（.pcap/.zip/...）
    // 的下载判定为 insecure download 直接拦截（控制台只留一条 warning，任务看着"已完成"），
    // 这里显式带上提示，并 bump sequence 让该快照覆盖服务端已推送的 handed-off 终态。
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
    if (!window.isSecureContext) {
      result.data.tasks = result.data.tasks.map((task) => ({
        ...task,
        notice: t('fileTransfer.insecureDownloadHint'),
        sequence: task.sequence + 1,
      }));
    }
    return result;
  },
  resolveSftpConflict: async (request: SftpResolveConflictRequest) => {
    // 本地 FSA 下载冲突：服务端没有 waiting-conflict 记录，直接唤醒等待中的落盘逻辑。
    const pendingLocal = webDownloadConflictResolvers.get(request.taskId);
    if (pendingLocal) {
      pendingLocal.resolve({ policy: request.policy, renamedPath: request.renamedPath });
      return { success: true };
    }
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
          enqueueWebUpload(taskId, 0);
        }
      });
    }
    return result;
  },
  cancelSftpTransfer: async (request: SftpTransferTaskRequest) => {
    webUploadQueue.remove(request.taskId);
    // 取消时让仍在等冲突裁决的下载立即以 AbortError 退出。
    webDownloadConflictResolvers.get(request.taskId)?.reject(new DOMException('Aborted', 'AbortError'));
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
      enqueueWebUpload(request.taskId, result.data.resumedFrom || 0, result.data);
    } else if (result.success && result.data.direction === 'download') {
      // 服务端已把下载任务状态重置为 queued；重新驱动本地 FSA 流式落盘（可续传 checkpoint）。
      const ctx = webSftpDownloadContexts.get(request.taskId);
      if (!ctx) {
        return makeError<SftpTransferTaskSnapshot>(
          'Download cannot be resumed: the local destination is no longer available',
          'not-found',
        );
      }
      void streamWebDownload({
        ...result.data,
        downloadUrl: ctx.downloadUrl,
        conflictPolicy: ctx.conflictPolicy ?? result.data.conflictPolicy,
      }, ctx.dirHandle);
    }
    return result;
  },
  discardSftpTransfer: async (request: SftpTransferTaskRequest) => {
    webUploadQueue.remove(request.taskId);
    webDownloadConflictResolvers.get(request.taskId)?.reject(new DOMException('Aborted', 'AbortError'));
    const result = await sftpRequest<void>(
      `/api/sftp/transfers/${encodeURIComponent(request.taskId)}`,
      { method: 'DELETE' },
    );
    if (result.success) {
      const source = webSftpTaskSources.get(request.taskId);
      if (source) selectedFiles.delete(source);
      webSftpTaskSources.delete(request.taskId);
      webSftpDownloadContexts.delete(request.taskId);
    }
    return result;
  },
  listSftpTransfers: (connectionId?: string) => sftpRequest<SftpListTransfersResult>(
    `/api/sftp/transfers${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`,
  ),
  onSftpTransferEvent: (callback) => on('sftp-transfer-event', callback),
  reportSftpDownloadStatus: async (taskId, update) => {
    await reportWebSftpDownloadStatus(taskId, update);
    return { success: true };
  },
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
  // 暂停：除前端 store 停止等待外，还要让网关掐断在途远端命令，
  // 否则界面上已暂停、远端那条命令仍会跑完。
  // 带上 connectionId 时只掐断该连接（多标签页下不会误伤其它会话正在跑的 Agent 命令）；
  // 不传时保持旧行为（取消本客户端全部在途执行）。
  agentPauseTask: (connectionId) => request<void>('/api/agent/pause', {
    method: 'POST',
    body: JSON.stringify(connectionId ? { connectionId } : {}),
  }),
  // 继续无需后端动作：恢复由前端 store 重新驱动流程（桌面端 agent_resume_task 同样为空实现）。
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

  // Web 部署：网关没有"系统从休眠恢复"这一事件来源（那是 Tauri 侧的应用事件）。
  // 此处仍保留订阅以满足同一份运行时契约；Web 下的等效场景是 WS 重连，
  // 已由 useSessionBridge 在 socket 重连时做同一套会话存活重校并重连。
  onSystemResume: (callback) => on('system-resume', callback),

  // Web 专用：查询登录状态（含是否仍为默认密码）。
  getAuthStatus: () => request<{ authenticated: boolean; usingDefaultPassword: boolean; passwordManaged: boolean }>(
    '/api/auth-status',
  ),
  // Web 专用：修改登录密码，校验旧密码，成功后当前会话保持登录。
  webChangePassword: (oldPassword, newPassword) => request<void>('/api/change-password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  }),
  // Web 专用：MCP 服务端策略（data/mcp-policy.json）。
  mcpGetConfig: () => request<McpConfigSnapshot>('/api/mcp/config'),
  mcpSaveConfig: (policy: McpPolicyConfig) => request<McpConfigSaveResult>('/api/mcp/config', {
    method: 'POST',
    body: JSON.stringify({ policy }),
  }),
};

export function installWebApi(): void {
  connectEvents();
  registerPageHideCleanup();
  // 标记当前运行在 Web 部署下，供 UI 判断是否展示密码相关入口。
  window.__AISSH_WEB__ = true;
  window.electronAPI = webApi;
}
