const posixPath = require('node:path').posix;
const { randomUUID } = require('node:crypto');
const { sftpProtocolPath } = require('./sftp-items.cjs');

const CHUNK_SIZE = 64 * 1024;
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_MS = 2000;
// Progress is advisory UI data. Throttle snapshots so a fast multi-file upload
// cannot flood the browser WebSocket and starve rendering/input handling.
const PROGRESS_EMIT_MS = 200;
const TERMINAL_STATUSES = new Set([
  'completed', 'skipped', 'canceled', 'interrupted', 'failed', 'handed-off',
]);

class TransferError extends Error {
  constructor(message, code = 'io-error', retryable = true) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function now() {
  return Date.now();
}

function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

function callSftp(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });
}

async function pathExists(sftp, remotePath) {
  try {
    await callSftp(sftp, 'lstat', remotePath);
    return true;
  } catch (error) {
    if (error?.code === 2) return false;
    throw error;
  }
}

function taskName(remotePath) {
  return posixPath.basename(remotePath) || 'transfer';
}

function temporaryRemotePath(remotePath, taskId) {
  const parent = posixPath.dirname(remotePath);
  const name = taskName(remotePath);
  return posixPath.join(parent, `.${name}.${taskId}.part`);
}

function backupRemotePath(remotePath, taskId) {
  const parent = posixPath.dirname(remotePath);
  const name = taskName(remotePath);
  return posixPath.join(parent, `.${name}.${taskId}.backup`);
}

/**
 * 用临时文件提交覆盖目标。
 *
 * 普通 SFTP RENAME 不保证能覆盖已存在目标（OpenSSH 会直接返回
 * SSH_FX_FAILURE / code 4），所以不能直接 rename(temp, destination)。
 * 目标存在时先把目标改名为备份，再把临时文件改名为目标，最后删除备份；
 * 中间任一步失败都尽量回滚，避免把原文件弄丢。
 */
async function commitRemoteTemp(sftp, temporaryPath, destinationPath, taskId) {
  if (!(await pathExists(sftp, destinationPath))) {
    await callSftp(sftp, 'rename', temporaryPath, destinationPath);
    return 'atomic-create';
  }

  const backupPath = backupRemotePath(destinationPath, taskId);
  await removeRemoteQuiet(sftp, backupPath);
  await callSftp(sftp, 'rename', destinationPath, backupPath);
  try {
    await callSftp(sftp, 'rename', temporaryPath, destinationPath);
  } catch (error) {
    await callSftp(sftp, 'rename', backupPath, destinationPath).catch(() => undefined);
    throw error;
  }
  try {
    await callSftp(sftp, 'unlink', backupPath);
  } catch (error) {
    await callSftp(sftp, 'unlink', destinationPath).catch(() => undefined);
    await callSftp(sftp, 'rename', backupPath, destinationPath).catch(() => undefined);
    throw error;
  }
  return 'best-effort-replace';
}

function checkpointRemotePath(temporaryPath) {
  return `${temporaryPath}.meta`;
}

function suggestedRemotePath(remotePath, taskId) {
  const extension = posixPath.extname(remotePath);
  const stem = posixPath.basename(remotePath, extension) || 'transfer';
  const suffix = taskId.slice(0, 8);
  return posixPath.join(posixPath.dirname(remotePath), `${stem} (${suffix})${extension}`);
}

/** 读取远端 JSON sidecar；损坏或不存在时返回 null。 */
async function readRemoteJson(sftp, remotePath) {
  if (!(await pathExists(sftp, remotePath))) return null;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(remotePath);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

/** 写入远端 JSON sidecar（先写临时再 rename 尽量原子）。 */
async function writeRemoteJson(sftp, remotePath, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const tempPath = `${remotePath}.tmp`;
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(tempPath);
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(payload);
  });
  if (await pathExists(sftp, remotePath)) {
    await callSftp(sftp, 'unlink', remotePath).catch(() => undefined);
  }
  await callSftp(sftp, 'rename', tempPath, remotePath);
}

async function remoteFileSize(sftp, remotePath) {
  try {
    const attrs = await callSftp(sftp, 'lstat', remotePath);
    return Number(attrs.size || 0);
  } catch {
    return 0;
  }
}

async function removeRemoteQuiet(sftp, remotePath) {
  if (await pathExists(sftp, remotePath)) {
    await callSftp(sftp, 'unlink', remotePath).catch(() => undefined);
  }
}

function makeSnapshot({ connectionId, batchId, direction, name, localPath, remotePath, totalBytes, conflictPolicy }) {
  const timestamp = now();
  return {
    taskId: randomUUID(),
    batchId,
    connectionId,
    attempt: 1,
    sequence: 0,
    direction,
    status: 'queued',
    name,
    localPath,
    remotePath,
    totalBytes,
    transferredBytes: 0,
    resumedFrom: 0,
    progress: 0,
    conflictPolicy,
    commitGuarantee: 'none',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeError(error) {
  if (error instanceof TransferError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error?.code === 2) return { code: 'not-found', message: error.message, retryable: false };
  if (error?.code === 3) return { code: 'permission-denied', message: error.message, retryable: false };
  return {
    code: 'io-error',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function createSftpTransferService({ getSftp, emitEvent }) {
  const tasks = new Map();
  const targetLocks = new Map();

  function assertOwner(task, clientId) {
    if (!task || task.clientId !== clientId) {
      throw new TransferError('SFTP transfer task not found', 'not-found', false);
    }
  }

  function emit(task) {
    const snapshot = task.snapshot;
    emitEvent(task.clientId, 'sftp-transfer-event', {
      type: 'snapshot',
      taskId: snapshot.taskId,
      connectionId: snapshot.connectionId,
      attempt: snapshot.attempt,
      sequence: snapshot.sequence,
      timestamp: snapshot.updatedAt,
      snapshot,
    });
  }

  function update(task, change, notify = true) {
    change(task.snapshot);
    task.snapshot.sequence += 1;
    task.snapshot.updatedAt = now();
    if (notify) emit(task);
    return task.snapshot;
  }

  function finish(task, status, error, commitGuarantee = 'none') {
    if (isTerminal(task.snapshot.status)) return task.snapshot;
    return update(task, (snapshot) => {
      snapshot.status = status;
      snapshot.error = error ? normalizeError(error) : undefined;
      snapshot.commitGuarantee = commitGuarantee;
      snapshot.progress = status === 'completed' ? 100 : snapshot.progress;
      snapshot.completedAt = now();
    });
  }

  async function withTargetLock(key, action) {
    const previous = targetLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => gate);
    targetLocks.set(key, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (targetLocks.get(key) === queued) targetLocks.delete(key);
    }
  }

  async function writeCheckpoint(sftp, temporaryPath, checkpoint) {
    await writeRemoteJson(sftp, checkpointRemotePath(temporaryPath), {
      ...checkpoint,
      updatedAt: now(),
    });
  }

  /**
   * 根据 sidecar + partial 大小决定续传起点；源变化时抛 source-changed。
   *
   * 关键不变量：客户端声明的续传起点 claimedOffset 绝不能超过服务端可确认的
   * serverOffset。否则客户端会只发送“从 claimedOffset 切片的尾巴”，而服务端若把
   * 它写到另一个偏移，就会静默得到截断文件并被标记为 completed。因此这里在打开/
   * 写入任何内容之前抛出 resume-offset-reset，要求客户端按 serverOffset 重传。
   */
  async function resolveResumeOffset(sftp, temporaryPath, task, sourceSize, sourceMtime, claimedOffset) {
    const metaPath = checkpointRemotePath(temporaryPath);
    const checkpoint = await readRemoteJson(sftp, metaPath);
    const partSize = await remoteFileSize(sftp, temporaryPath);
    let serverOffset = 0;
    let discardPartial = false;
    if (!checkpoint) {
      // 无可信 checkpoint 的 partial 不可续传，服务端只能确认到 0。
      discardPartial = partSize > 0;
      serverOffset = 0;
    } else {
      const sourceHead = String(task._sourceHead || '');
      const sourceTail = String(task._sourceTail || '');
      if (
        checkpoint.taskId !== task.snapshot.taskId
        || Number(checkpoint.sourceSize) !== sourceSize
        || Number(checkpoint.sourceMtime) !== sourceMtime
        || (checkpoint.sourceHead && sourceHead && checkpoint.sourceHead !== sourceHead)
        || (checkpoint.sourceTail && sourceTail && checkpoint.sourceTail !== sourceTail)
      ) {
        await removeRemoteQuiet(sftp, temporaryPath);
        await removeRemoteQuiet(sftp, metaPath);
        throw new TransferError('Source file changed; restart required', 'source-changed', false);
      }
      const trusted = Math.min(
        Number(checkpoint.confirmedOffset || 0),
        partSize,
        sourceSize || Number.MAX_SAFE_INTEGER,
      );
      if (partSize > trusted) {
        // partial 比 checkpoint 长：多出的字节无法信任，服务端只能确认到 0。
        discardPartial = true;
        serverOffset = 0;
      } else {
        serverOffset = trusted;
      }
    }

    if (claimedOffset > serverOffset) {
      // 不消费 body、不打开/写入/提交远端文件，交由上层请求排空 body 后返回错误。
      const error = new TransferError('Resume offset reset by server', 'resume-offset-reset', true);
      error.confirmedOffset = serverOffset;
      error.task = {
        ...task.snapshot,
        status: 'queued',
        resumedFrom: serverOffset,
        transferredBytes: serverOffset,
        progress: task.snapshot.totalBytes
          ? Math.min(99, Math.round((serverOffset / task.snapshot.totalBytes) * 100))
          : 0,
        updatedAt: now(),
      };
      throw error;
    }

    if (discardPartial) {
      await removeRemoteQuiet(sftp, temporaryPath);
      await removeRemoteQuiet(sftp, metaPath);
    }

    const offset = Math.min(claimedOffset || serverOffset, serverOffset);
    return offset > 0 ? offset : 0;
  }

  async function writeRequestToSftp(task, request) {
    const { snapshot } = task;
    const sftp = await getSftp(snapshot.connectionId, task.clientId);
    const remotePath = snapshot.remotePath;
    if (!remotePath) throw new TransferError('Upload target is missing', 'invalid-path', false);

    return withTargetLock(`${snapshot.connectionId}:${remotePath}`, async () => {
      if (task.canceled) {
        finish(task, 'canceled');
        return snapshot;
      }
      const protocolRemotePath = sftpProtocolPath(remotePath);
      const exists = await pathExists(sftp, protocolRemotePath);
      if (exists) {
        if (snapshot.conflictPolicy === 'ask') {
          update(task, (current) => {
            current.status = 'waiting-conflict';
            current.conflict = {
              sourcePath: current.localPath || current.name,
              destinationPath: remotePath,
              suggestedName: suggestedRemotePath(remotePath, current.taskId),
            };
          });
          const conflictError = new TransferError('Destination already exists', 'conflict', false);
          // HTTP 409 也携带任务快照，避免 WebSocket 建连竞态导致前端卡在 transferring。
          conflictError.task = snapshot;
          throw conflictError;
        }
        if (snapshot.conflictPolicy === 'skip') {
          return finish(task, 'skipped');
        }
        if (snapshot.conflictPolicy === 'rename') {
          snapshot.remotePath = suggestedRemotePath(remotePath, snapshot.taskId);
        }
      }

      const destination = snapshot.remotePath;
      const protocolDestination = sftpProtocolPath(destination);
      const temporaryPath = temporaryRemotePath(protocolDestination, snapshot.taskId);
      const sourceSize = Number(
        request.headers?.['x-sftp-source-size']
        || request.headers?.['content-length']
        || snapshot.totalBytes
        || 0,
      );
      const sourceMtime = Number(request.headers?.['x-sftp-source-mtime'] || 0);
      const sourceHead = String(request.headers?.['x-sftp-source-head'] || '');
      const sourceTail = String(request.headers?.['x-sftp-source-tail'] || '');
      task._sourceHead = sourceHead;
      task._sourceTail = sourceTail;
      const claimedOffset = Number(request.headers?.['x-sftp-resume-offset'] || 0);
      // 缺省视为整包完成（兼容旧客户端）；分片上传显式传 0/false
      const completeRaw = String(request.headers?.['x-sftp-upload-complete'] ?? '1').toLowerCase();
      const shouldCommit = completeRaw !== '0' && completeRaw !== 'false';
      let offset;
      try {
        offset = await resolveResumeOffset(
          sftp,
          temporaryPath,
          task,
          sourceSize,
          sourceMtime,
          claimedOffset,
        );
      } catch (error) {
        if (error instanceof TransferError && error.code === 'resume-offset-reset') {
          // 排空仍在发送的 body，避免连接被重置导致错误响应无法送达；不写任何远端数据。
          request.resume?.();
        }
        throw error;
      }

      // offset=0 用截断写；续传用 r+ 在指定 position 写入。
      const handle = await callSftp(sftp, 'open', temporaryPath, offset > 0 ? 'r+' : 'w');
      let lastCheckpointAt = now();
      let lastCheckpointBytes = offset;
      let lastProgressEmitAt = 0;
      const persistCheckpoint = async () => {
        await writeCheckpoint(sftp, temporaryPath, {
          taskId: snapshot.taskId,
          sourceSize,
          sourceMtime,
          sourceHead,
          sourceTail,
          totalBytes: sourceSize,
          confirmedOffset: offset,
          destinationPath: destination,
        });
        lastCheckpointAt = now();
        lastCheckpointBytes = offset;
      };
      try {
        update(task, (current) => {
          current.status = 'transferring';
          current.resumedFrom = offset;
          current.transferredBytes = offset;
          current.totalBytes = sourceSize || current.totalBytes || undefined;
          current.progress = current.totalBytes
            ? Math.min(99, Math.round((offset / current.totalBytes) * 100))
            : 0;
          current.error = undefined;
        });
        lastProgressEmitAt = now();
        if (offset > 0) {
          await persistCheckpoint();
        }

        for await (const input of request) {
          if (task.canceled) throw new TransferError('Transfer canceled', 'canceled', true);
          const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
          for (let start = 0; start < chunk.length; start += CHUNK_SIZE) {
            if (task.canceled) throw new TransferError('Transfer canceled', 'canceled', true);
            const part = chunk.subarray(start, Math.min(start + CHUNK_SIZE, chunk.length));
            // ssh2 WRITE 回调第二个参数是 bufferOffset+bytesWritten，不是文件绝对偏移。
            // 这里 bufferOffset 固定为 0，因此成功时应等于 part.length。
            const acknowledged = await new Promise((resolve, reject) => {
              sftp.write(handle, part, 0, part.length, offset, (error, bytesEnd) => {
                if (error) reject(error);
                else resolve(bytesEnd);
              });
            });
            if (!Number.isInteger(acknowledged) || acknowledged !== part.length) {
              throw new TransferError(`Invalid SFTP write result: ${acknowledged}`);
            }
            offset += part.length;
            update(task, (current) => {
              current.transferredBytes = offset;
              current.totalBytes = sourceSize || current.totalBytes || undefined;
              current.progress = current.totalBytes
                ? Math.min(99, Math.round((offset / current.totalBytes) * 100))
                : 0;
            }, false);
            const progressNow = now();
            if (progressNow - lastProgressEmitAt >= PROGRESS_EMIT_MS) {
              lastProgressEmitAt = progressNow;
              emit(task);
            }
            if (
              offset - lastCheckpointBytes >= CHECKPOINT_BYTES
              || now() - lastCheckpointAt >= CHECKPOINT_MS
            ) {
              await persistCheckpoint();
            }
          }
        }
        await callSftp(sftp, 'close', handle);

        // 分片未完成：落 checkpoint，回到 queued 等待下一片
        if (!shouldCommit) {
          await persistCheckpoint();
          return update(task, (current) => {
            current.status = 'queued';
            current.transferredBytes = offset;
            current.totalBytes = sourceSize || current.totalBytes || undefined;
            current.progress = current.totalBytes
              ? Math.min(99, Math.round((offset / current.totalBytes) * 100))
              : 0;
          });
        }

        update(task, (current) => { current.status = 'committing'; });
        const commitGuarantee = await commitRemoteTemp(
          sftp,
          temporaryPath,
          protocolDestination,
          snapshot.taskId,
        );
        await removeRemoteQuiet(sftp, checkpointRemotePath(temporaryPath));
        return finish(task, 'completed', undefined, commitGuarantee);
      } catch (error) {
        await callSftp(sftp, 'close', handle).catch(() => undefined);
        const canceled = error instanceof TransferError && error.code === 'canceled';
        if (canceled) {
          // 取消代表用户明确放弃本次上传，不保留远端 partial/meta；
          // 否则目录里会留下 .part 与 .meta 两个隐藏文件。
          await removeRemoteQuiet(sftp, temporaryPath);
          await removeRemoteQuiet(sftp, checkpointRemotePath(temporaryPath));
        } else if (offset > 0) {
          // 失败/网络中断尽量落最终 checkpoint，便于重试续传。
          await writeCheckpoint(sftp, temporaryPath, {
            taskId: snapshot.taskId,
            sourceSize,
            sourceMtime,
            sourceHead,
            sourceTail,
            totalBytes: sourceSize,
            confirmedOffset: offset,
            destinationPath: destination,
          }).catch(() => undefined);
        }
        if (canceled) {
          return finish(task, 'canceled');
        }
        if (error instanceof TransferError && error.code === 'conflict') throw error;
        if (error instanceof TransferError && error.code === 'source-changed') {
          finish(task, 'failed', error);
          throw error;
        }
        finish(task, 'failed', error);
        throw error;
      }
    });
  }

  function startUpload(clientId, request) {
    if (!request?.connectionId || !Array.isArray(request.files) || request.files.length === 0) {
      throw new TransferError('No files selected', 'invalid-path', false);
    }
    const remoteDirectory = String(request.remoteDirectory || '/');
    const conflictPolicy = request.conflictPolicy || 'ask';
    const batchId = randomUUID();
    const created = request.files.map((file) => {
      if (!file?.ref || !file?.name || file.name.includes('/') || file.name.includes('\\')) {
        throw new TransferError('Web upload requires a selected file reference', 'invalid-path', false);
      }
      const remotePath = posixPath.join(remoteDirectory, file.name);
      const task = {
        clientId,
        canceled: false,
        snapshot: makeSnapshot({
          connectionId: request.connectionId,
          batchId,
          direction: 'upload',
          name: file.name,
          localPath: file.ref,
          remotePath,
          totalBytes: Number.isFinite(file.size) ? file.size : undefined,
          conflictPolicy,
        }),
      };
      tasks.set(task.snapshot.taskId, task);
      emit(task);
      return task.snapshot;
    });
    return { tasks: created };
  }

  function startDownload(clientId, request, downloadBasePath) {
    if (!request?.connectionId || !Array.isArray(request.remotePaths) || request.remotePaths.length === 0) {
      throw new TransferError('No remote files selected', 'invalid-path', false);
    }
    // destination.ref 表示浏览器 FSA 流式落盘；否则交给浏览器下载管理器。
    const streaming = Boolean(request.destination?.ref);
    const batchId = randomUUID();
    const created = request.remotePaths.map((remotePath) => {
      const normalizedPath = String(remotePath || '');
      if (!normalizedPath || normalizedPath === '/') {
        throw new TransferError('Invalid remote download path', 'invalid-path', false);
      }
      const snapshot = makeSnapshot({
        connectionId: request.connectionId,
        batchId,
        direction: 'download',
        name: taskName(normalizedPath),
        remotePath: normalizedPath,
        totalBytes: undefined,
        conflictPolicy: request.conflictPolicy || 'ask',
      });
      if (streaming) {
        snapshot.status = 'queued';
        snapshot.localPath = request.destination.ref;
      } else {
        snapshot.status = 'handed-off';
        snapshot.commitGuarantee = 'browser-managed';
        snapshot.completedAt = now();
      }
      const task = { clientId, canceled: false, snapshot };
      tasks.set(snapshot.taskId, task);
      emit(task);
      return {
        ...snapshot,
        // handed-off 由浏览器下载管理器发起顶层导航，无法携带 x-sftp-client-id 请求头，
        // 因此把客户端标识一并放进 URL，服务端据此定位本客户端的 SFTP 会话。
        // 它只用于会话路由（鉴权仍由会话 Cookie 负责），与请求头等价、不额外提权。
        downloadUrl: `${downloadBasePath}/${encodeURIComponent(request.connectionId)}/download`
          + `?path=${encodeURIComponent(normalizedPath)}`
          + `&clientId=${encodeURIComponent(clientId)}`,
      };
    });
    return { tasks: created };
  }

  function resolveConflict(clientId, request) {
    const task = tasks.get(request?.taskId);
    assertOwner(task, clientId);
    if (task.snapshot.attempt !== request.attempt || task.snapshot.status !== 'waiting-conflict') {
      throw new TransferError('Transfer is not waiting for this conflict decision', 'conflict', false);
    }
    if (!['overwrite', 'skip', 'rename'].includes(request.policy)) {
      throw new TransferError('Conflict resolution requires a concrete policy', 'invalid-path', false);
    }
    update(task, (snapshot) => {
      snapshot.conflictPolicy = request.policy;
      if (request.policy === 'rename') {
        snapshot.remotePath = request.renamedPath || snapshot.conflict?.suggestedName;
      }
      snapshot.status = 'queued';
      snapshot.conflict = undefined;
    });

    // 将策略应用到同 client/connection/batch/direction 下尚未提交的剩余任务。
    if (request.applyToBatch && task.snapshot.batchId) {
      for (const peer of tasks.values()) {
        if (
          peer.clientId !== clientId
          || peer.snapshot.taskId === task.snapshot.taskId
          || peer.snapshot.connectionId !== task.snapshot.connectionId
          || peer.snapshot.batchId !== task.snapshot.batchId
          || peer.snapshot.direction !== task.snapshot.direction
          || !['waiting-conflict', 'queued', 'checking'].includes(peer.snapshot.status)
        ) {
          continue;
        }
        update(peer, (snapshot) => {
          snapshot.conflictPolicy = request.policy;
          if (request.policy === 'rename' && snapshot.conflict?.suggestedName) {
            snapshot.remotePath = snapshot.conflict.suggestedName;
          }
          snapshot.status = 'queued';
          snapshot.conflict = undefined;
        });
      }
    }
  }

  function cancel(clientId, request) {
    const task = tasks.get(request?.taskId);
    assertOwner(task, clientId);
    if (task.snapshot.status === 'committing') {
      throw new TransferError('Transfer commit is in progress', 'commit-in-progress', false);
    }
    if (isTerminal(task.snapshot.status)) return;
    task.canceled = true;
    if (['queued', 'checking', 'waiting-conflict'].includes(task.snapshot.status)) {
      finish(task, 'canceled');
    } else {
      update(task, (snapshot) => { snapshot.status = 'canceling'; });
    }
  }

  async function retry(clientId, request) {
    const task = tasks.get(request?.taskId);
    assertOwner(task, clientId);
    if (!['failed', 'interrupted', 'canceled', 'skipped'].includes(task.snapshot.status)) {
      throw new TransferError('Transfer is not retryable', 'conflict', false);
    }
    task.canceled = false;

    // 读取远端 checkpoint，重试时保留可信续传 offset。
    let resumeFrom = 0;
    if (task.snapshot.direction === 'upload' && task.snapshot.remotePath) {
      try {
        const sftp = await getSftp(task.snapshot.connectionId, task.clientId);
        const temporaryPath = temporaryRemotePath(task.snapshot.remotePath, task.snapshot.taskId);
        const checkpoint = await readRemoteJson(sftp, checkpointRemotePath(temporaryPath));
        const partSize = await remoteFileSize(sftp, temporaryPath);
        if (checkpoint && checkpoint.taskId === task.snapshot.taskId) {
          resumeFrom = Math.min(Number(checkpoint.confirmedOffset || 0), partSize);
        }
      } catch {
        resumeFrom = 0;
      }
    }

    return update(task, (snapshot) => {
      snapshot.attempt += 1;
      snapshot.status = 'queued';
      snapshot.sequence = 0;
      snapshot.transferredBytes = resumeFrom;
      snapshot.resumedFrom = resumeFrom;
      snapshot.progress = snapshot.totalBytes
        ? Math.min(99, Math.round((resumeFrom / snapshot.totalBytes) * 100))
        : 0;
      snapshot.error = undefined;
      snapshot.conflict = undefined;
      snapshot.completedAt = undefined;
      snapshot.commitGuarantee = 'none';
    });
  }

  /**
   * 浏览器 FSA 流式下载由前端真正执行，服务端只持有任务记录。前端通过该入口把
   * transferring/terminal 状态回报给服务端，否则任务会永远停在 queued，无法重试。
   *
   * 只接受 direction==='download'；回报必须携带当前 attempt，旧 attempt 的迟到回报
   * 会被幂等忽略（避免污染重试后的新任务）；终态任务忽略后续回报（幂等）；未知状态
   * 直接报错，避免把非法状态静默写进快照。
   */
  function reportDownload(clientId, report = {}) {
    const task = tasks.get(report?.taskId);
    assertOwner(task, clientId);
    if (task.snapshot.direction !== 'download') {
      throw new TransferError('Transfer is not a download', 'invalid-path', false);
    }
    // attempt 不匹配（含缺失）说明是上一轮尝试的迟到回报，忽略而不改写当前快照。
    if (!Number.isInteger(report?.attempt) || report.attempt !== task.snapshot.attempt) {
      return task.snapshot;
    }
    const { status, transferredBytes, totalBytes, error } = report;
    // 已经结束的任务不再改写（浏览器可能重复/迟到回报）。
    if (isTerminal(task.snapshot.status)) return task.snapshot;

    if (status === 'transferring') {
      // 仅允许 queued/transferring -> transferring，其它状态忽略（如 handed-off 仅用于非流式）。
      if (!['queued', 'transferring'].includes(task.snapshot.status)) {
        return task.snapshot;
      }
      return update(task, (snapshot) => {
        snapshot.status = 'transferring';
        if (Number.isFinite(transferredBytes)) {
          snapshot.transferredBytes = Math.max(0, transferredBytes);
        }
        if (Number.isFinite(totalBytes) && totalBytes >= 0) {
          snapshot.totalBytes = totalBytes;
        }
        snapshot.progress = snapshot.totalBytes
          ? Math.min(99, Math.round((snapshot.transferredBytes / snapshot.totalBytes) * 100))
          : 0;
        snapshot.error = undefined;
      });
    }

    if (status === 'completed') {
      if (Number.isFinite(transferredBytes) && transferredBytes >= 0) {
        task.snapshot.transferredBytes = transferredBytes;
      }
      if (Number.isFinite(totalBytes) && totalBytes >= 0) {
        task.snapshot.totalBytes = totalBytes;
      }
      return finish(task, 'completed', undefined, 'browser-managed');
    }

    if (status === 'failed') {
      return finish(
        task,
        'failed',
        new TransferError(
          error?.message || 'Download failed',
          error?.code || 'io-error',
          error?.retryable !== false,
        ),
      );
    }

    if (status === 'canceled') {
      return finish(task, 'canceled');
    }

    if (status === 'skipped') {
      return finish(task, 'skipped');
    }

    throw new TransferError('Unknown download status', 'invalid-path', false);
  }

  async function discard(clientId, request) {
    const task = tasks.get(request?.taskId);
    assertOwner(task, clientId);
    if (!isTerminal(task.snapshot.status)) {
      throw new TransferError('Transfer is still active', 'conflict', false);
    }
    if (task.snapshot.remotePath) {
      try {
        const sftp = await getSftp(task.snapshot.connectionId, task.clientId);
        const temporaryPath = temporaryRemotePath(task.snapshot.remotePath, task.snapshot.taskId);
        await removeRemoteQuiet(sftp, temporaryPath);
        await removeRemoteQuiet(sftp, checkpointRemotePath(temporaryPath));
      } catch {
        // 清理失败不阻塞丢弃记录。
      }
    }
    tasks.delete(task.snapshot.taskId);
  }

  function list(clientId, connectionId) {
    return {
      tasks: [...tasks.values()]
        .filter((task) => task.clientId === clientId && (!connectionId || task.snapshot.connectionId === connectionId))
        .map((task) => task.snapshot)
        .sort((left, right) => left.createdAt - right.createdAt),
    };
  }

  return {
    cancel,
    discard,
    list,
    reportDownload,
    resolveConflict,
    retry,
    startDownload,
    startUpload,
    upload: async (clientId, taskId, request) => {
      const task = tasks.get(taskId);
      assertOwner(task, clientId);
      // queued=首片/续传；transferring 仅防御并发误入，正常分片结束会回到 queued
      if (
        task.snapshot.direction !== 'upload'
        || !['queued', 'transferring'].includes(task.snapshot.status)
      ) {
        throw new TransferError('Transfer is not ready for upload data', 'conflict', false);
      }
      return writeRequestToSftp(task, request);
    },
  };
}

module.exports = {
  checkpointRemotePath,
  createSftpTransferService,
  suggestedRemotePath,
  temporaryRemotePath,
};
