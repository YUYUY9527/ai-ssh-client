const posixPath = require('node:path').posix;
const { randomUUID } = require('node:crypto');
const { sftpProtocolPath } = require('./sftp-items.cjs');

const CHUNK_SIZE = 64 * 1024;
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_MS = 2000;
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

  function update(task, change) {
    change(task.snapshot);
    task.snapshot.sequence += 1;
    task.snapshot.updatedAt = now();
    emit(task);
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

  /** 根据 sidecar + partial 大小决定续传起点；源变化时抛 source-changed。 */
  async function resolveResumeOffset(sftp, temporaryPath, task, sourceSize, sourceMtime, claimedOffset) {
    const metaPath = checkpointRemotePath(temporaryPath);
    const checkpoint = await readRemoteJson(sftp, metaPath);
    const partSize = await remoteFileSize(sftp, temporaryPath);
    if (!checkpoint) {
      if (partSize > 0) {
        // 无可信 checkpoint 的 partial 不可续传，截断重来。
        await removeRemoteQuiet(sftp, temporaryPath);
      }
      return 0;
    }
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
    // partial 比 checkpoint 长则截断到可信 offset（通过重写策略：仅从 trusted 继续写）。
    if (partSize > trusted) {
      // SFTP 无法轻松 truncate，删除并要求完整重传。
      await removeRemoteQuiet(sftp, temporaryPath);
      await removeRemoteQuiet(sftp, metaPath);
      return 0;
    }
    const offset = Math.min(claimedOffset || trusted, trusted);
    return offset > 0 ? offset : 0;
  }

  async function writeRequestToSftp(task, request) {
    const { snapshot } = task;
    const sftp = await getSftp(snapshot.connectionId);
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
          throw new TransferError('Destination already exists', 'conflict', false);
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
      let offset = await resolveResumeOffset(
        sftp,
        temporaryPath,
        task,
        sourceSize,
        sourceMtime,
        claimedOffset,
      );

      // offset=0 用截断写；续传用 r+ 在指定 position 写入。
      const handle = await callSftp(sftp, 'open', temporaryPath, offset > 0 ? 'r+' : 'w');
      let lastCheckpointAt = now();
      let lastCheckpointBytes = offset;
      try {
        update(task, (current) => {
          current.status = 'transferring';
          current.resumedFrom = offset;
          current.transferredBytes = offset;
          current.totalBytes = sourceSize || current.totalBytes || undefined;
          current.progress = current.totalBytes
            ? Math.min(99, Math.round((offset / current.totalBytes) * 100))
            : 0;
        });
        if (offset > 0) {
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
        }

        for await (const input of request) {
          if (task.canceled) throw new TransferError('Transfer canceled', 'canceled', true);
          const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
          for (let start = 0; start < chunk.length; start += CHUNK_SIZE) {
            if (task.canceled) throw new TransferError('Transfer canceled', 'canceled', true);
            const part = chunk.subarray(start, Math.min(start + CHUNK_SIZE, chunk.length));
            const written = await new Promise((resolve, reject) => {
              sftp.write(handle, part, 0, part.length, offset, (error, nextOffset) => {
                if (error) reject(error);
                else resolve(nextOffset);
              });
            });
            if (!Number.isInteger(written) || written !== offset + part.length) {
              throw new TransferError(`Invalid SFTP write result: ${written}`);
            }
            offset = written;
            update(task, (current) => {
              current.transferredBytes = offset;
              current.totalBytes = sourceSize || current.totalBytes || undefined;
              current.progress = current.totalBytes
                ? Math.min(99, Math.round((offset / current.totalBytes) * 100))
                : 0;
            });
            if (
              offset - lastCheckpointBytes >= CHECKPOINT_BYTES
              || now() - lastCheckpointAt >= CHECKPOINT_MS
            ) {
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
            }
          }
        }
        await callSftp(sftp, 'close', handle);
        update(task, (current) => { current.status = 'committing'; });
        await callSftp(sftp, 'rename', temporaryPath, protocolDestination);
        await removeRemoteQuiet(sftp, checkpointRemotePath(temporaryPath));
        return finish(task, 'completed', undefined, exists ? 'best-effort-replace' : 'atomic-create');
      } catch (error) {
        await callSftp(sftp, 'close', handle).catch(() => undefined);
        // 取消/失败时尽量落最终 checkpoint，便于重试续传。
        if (offset > 0) {
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
        if (error instanceof TransferError && error.code === 'canceled') {
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
        downloadUrl: `${downloadBasePath}/${encodeURIComponent(request.connectionId)}/download?path=${encodeURIComponent(normalizedPath)}`,
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
        const sftp = await getSftp(task.snapshot.connectionId);
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

  async function discard(clientId, request) {
    const task = tasks.get(request?.taskId);
    assertOwner(task, clientId);
    if (!isTerminal(task.snapshot.status)) {
      throw new TransferError('Transfer is still active', 'conflict', false);
    }
    if (task.snapshot.remotePath) {
      try {
        const sftp = await getSftp(task.snapshot.connectionId);
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
    resolveConflict,
    retry,
    startDownload,
    startUpload,
    upload: async (clientId, taskId, request) => {
      const task = tasks.get(taskId);
      assertOwner(task, clientId);
      if (task.snapshot.direction !== 'upload' || task.snapshot.status !== 'queued') {
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
