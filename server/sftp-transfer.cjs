const posixPath = require('node:path').posix;
const { randomUUID } = require('node:crypto');
const { ensureRemoteDirectory, sftpProtocolPath } = require('./sftp-items.cjs');
const { writePipelined } = require('./sftp-pipelined-write.cjs');

const CHUNK_SIZE = 64 * 1024;
const CHECKPOINT_BYTES = 4 * 1024 * 1024;
const CHECKPOINT_MS = 2000;
// Progress is advisory UI data. Throttle snapshots so a fast multi-file upload
// cannot flood the browser WebSocket and starve rendering/input handling.
const PROGRESS_EMIT_MS = 200;
const TERMINAL_STATUSES = new Set([
  'completed', 'skipped', 'canceled', 'interrupted', 'failed', 'handed-off',
]);
// 上传看门狗：content PUT 路由关闭了 socket 超时（长分片不能被掐断），
// 客户端半开断开（无 FIN/RST）时请求会永久挂起。长时间既无请求字节也无写确认
// 就主动断开，避免任务卡在 transferring、同目标锁被永久占用。
const UPLOAD_IDLE_TIMEOUT_MS = 180 * 1000;
const UPLOAD_WATCHDOG_INTERVAL_MS = 30 * 1000;
// 任务记录持久化/清理：重启不丢远端 partial 的清理线索；干净终态自动过期，
// failed/interrupted 保留到用户 discard（它们持有远端残留的清理入口）。
const TASK_PERSIST_THROTTLE_MS = 1000;
const TASK_GC_INTERVAL_MS = 60 * 60 * 1000;
const TASK_GC_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TASK_GC_MAX_RECORDS = 1000;
const CLEAN_TERMINAL_STATUSES = new Set(['completed', 'skipped', 'canceled', 'handed-off']);

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

/**
 * 写入远端 JSON sidecar（直接覆盖）。
 *
 * checkpoint 不需要 tmp+rename 的原子替换：读取端本就校验内容，损坏/截断的 JSON
 * 按“无 checkpoint”安全重来；同一 sidecar 的读写由目标锁与顺序分片保证不竞态。
 * 直接覆盖把每次 checkpoint 从 ~5 个串行 SFTP 往返降到 ~2 个。
 */
async function writeRemoteJson(sftp, remotePath, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  await new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath);
    stream.on('error', reject);
    stream.on('close', resolve);
    stream.end(payload);
  });
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

function createSftpTransferService({ getSftp, emitEvent, storage }) {
  const tasks = new Map();
  const targetLocks = new Map();

  // ---- 任务记录持久化（可选）----
  // tasks 原本纯内存：服务重启后远端 .part/.meta 失去清理线索，任务记录也会无限增长。
  // 注入 storage 后节流落盘，重启时把非终态任务降级为 interrupted（可重试/可丢弃），
  // 并自动过期干净终态记录。不注入 storage（单元测试）保持纯内存行为。
  let persistTimer = null;
  function persistNow() {
    if (!storage) return;
    try {
      storage.save({
        version: 1,
        tasks: [...tasks.values()].map((task) => ({ clientId: task.clientId, snapshot: task.snapshot })),
      });
    } catch {
      // 持久化失败不影响传输本身，最坏情况是重启后丢失记录。
    }
  }
  function schedulePersist() {
    if (!storage || persistTimer) return;
    // 节流而非 debounce：高频进度更新不能把落盘饿死。
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, TASK_PERSIST_THROTTLE_MS);
    persistTimer.unref?.();
  }
  function gcTasks() {
    const deadline = now() - TASK_GC_TTL_MS;
    for (const [taskId, task] of tasks) {
      const { status, completedAt, updatedAt } = task.snapshot;
      if (CLEAN_TERMINAL_STATUSES.has(status) && (completedAt || updatedAt || 0) < deadline) {
        tasks.delete(taskId);
      }
    }
    // 总量上限兜底：优先驱逐最旧的干净终态记录；failed/interrupted 持有远端
    // partial 清理线索，不自动驱逐。
    if (tasks.size > TASK_GC_MAX_RECORDS) {
      const evictable = [...tasks.values()]
        .filter((task) => CLEAN_TERMINAL_STATUSES.has(task.snapshot.status))
        .sort((left, right) => (left.snapshot.completedAt || left.snapshot.updatedAt || 0)
          - (right.snapshot.completedAt || right.snapshot.updatedAt || 0));
      for (const task of evictable) {
        if (tasks.size <= TASK_GC_MAX_RECORDS) break;
        tasks.delete(task.snapshot.taskId);
      }
    }
  }
  if (storage) {
    try {
      const stored = storage.load();
      const records = Array.isArray(stored?.tasks) ? stored.tasks : [];
      for (const record of records) {
        const snapshot = record?.snapshot;
        if (!snapshot?.taskId || !record?.clientId) continue;
        const restored = { ...snapshot };
        if (!isTerminal(restored.status)) {
          restored.status = 'interrupted';
          restored.error = {
            code: 'interrupted',
            message: 'Transfer interrupted by server restart',
            retryable: true,
          };
          restored.completedAt = now();
        }
        tasks.set(restored.taskId, { clientId: record.clientId, canceled: false, snapshot: restored });
      }
    } catch {
      // 持久化文件损坏按空处理，不阻塞服务启动。
    }
    gcTasks();
    persistNow();
    const gcTimer = setInterval(() => {
      gcTasks();
      schedulePersist();
    }, TASK_GC_INTERVAL_MS);
    gcTimer.unref?.();
    process.once('exit', persistNow);
  }

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
    schedulePersist();
    return task.snapshot;
  }

  function finish(task, status, error, commitGuarantee = 'none') {
    if (isTerminal(task.snapshot.status)) return task.snapshot;
    return update(task, (snapshot) => {
      snapshot.status = status;
      snapshot.error = error ? normalizeError(error) : undefined;
      snapshot.commitGuarantee = commitGuarantee;
      snapshot.progress = status === 'completed' ? 100 : snapshot.progress;
      snapshot.completedAt = status === 'paused' ? undefined : now();
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
          // 排空仍在发送的 body，避免连接被重置导致在途分片字节白传、响应送达不稳定。
          request.resume?.();
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
      // 文件夹上传：先递归创建嵌套父目录（平铺上传 ensureParents=false，跳过，零额外往返）。
      if (task.ensureParents) {
        await ensureRemoteDirectory(sftp, posixPath.dirname(destination));
      }
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
      // 看门狗：以“请求字节被消费 + SFTP 写确认”作为活动信号，超时无活动就 destroy
      // 请求，错误沿 writePipelined 的正常失败路径传播，在途写会先 settle，
      // checkpoint/锁释放逻辑不受影响。
      // 活动信号必须在“字节被消费处”采集：包一层异步生成器，每消费一块记一次活动。
      // 绝不能给 request.socket 挂 'data' 监听——前置 SFTP 往返（lstat/读 checkpoint/
      // open）期间请求体已在途，Node 会因背压暂停 socket；额外的 socket 'data' 监听
      // 会破坏解析器的 pause/resume 簿记，socket 暂停后再也不恢复，请求体只交付第一块
      // 就永久断流（表现为上传卡 0%、目标锁被占）。也不能给 request 本身挂 'data'，
      // 那会偷走 for-await 消费的字节。
      let lastActivityAt = now();
      const markActivity = () => { lastActivityAt = now(); };
      const trackedSource = (async function* () {
        for await (const chunk of request) {
          markActivity();
          yield chunk;
        }
      })();
      const watchdog = setInterval(() => {
        if (now() - lastActivityAt >= UPLOAD_IDLE_TIMEOUT_MS) {
          request.destroy(new TransferError(
            'Upload stalled: no data or write confirmation',
            'upload-stalled',
            true,
          ));
        }
      }, UPLOAD_WATCHDOG_INTERVAL_MS);
      watchdog.unref?.();
      let lastCheckpointAt = now();
      let lastCheckpointBytes = offset;
      let lastProgressEmitAt = 0;
      const buildCheckpoint = (confirmed) => ({
        taskId: snapshot.taskId,
        sourceSize,
        sourceMtime,
        sourceHead,
        sourceTail,
        totalBytes: sourceSize,
        confirmedOffset: confirmed,
        destinationPath: destination,
      });
      // 后台单飞 checkpoint：最多 1 个写请求在途；在途期间又触发阈值时只记录最新
      // 偏移，前一个完成后追写最新值——天然有序，旧值不会覆盖新值。onAck 不再
      // await 落盘，写管线不会为 checkpoint 的 SFTP 往返停摆（高延迟链路的主要损耗）。
      let checkpointInFlight = false;
      let checkpointPendingOffset = null;
      let checkpointIdleWaiters = [];
      let checkpointStopped = false;
      const notifyCheckpointIdle = () => {
        const waiters = checkpointIdleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      };
      const waitCheckpointIdle = () => (checkpointInFlight
        ? new Promise((resolve) => checkpointIdleWaiters.push(resolve))
        : Promise.resolve());
      const scheduleCheckpoint = () => {
        if (checkpointStopped) return;
        lastCheckpointAt = now();
        lastCheckpointBytes = offset;
        if (checkpointInFlight) {
          checkpointPendingOffset = offset;
          return;
        }
        checkpointInFlight = true;
        const run = async (confirmed) => {
          if (checkpointStopped) {
            checkpointInFlight = false;
            notifyCheckpointIdle();
            return;
          }
          try {
            await writeCheckpoint(sftp, temporaryPath, buildCheckpoint(confirmed));
          } catch {
            // 后台 checkpoint 失败不打断传输：最多损失一个续传点，
            // 分片结束/失败路径仍会同步落最终 checkpoint。
          }
          const pending = checkpointPendingOffset;
          checkpointPendingOffset = null;
          if (!checkpointStopped && pending != null && pending > confirmed) {
            await run(pending);
            return;
          }
          checkpointInFlight = false;
          notifyCheckpointIdle();
        };
        void run(offset);
      };
      // 同步 checkpoint：用于续传开始/分片结束/失败路径——必须在响应或清理之前
      // 落盘。先等后台单飞落地，避免较旧的后台写覆盖较新的同步写。
      const persistCheckpoint = async () => {
        await waitCheckpointIdle();
        checkpointPendingOffset = null;
        await writeCheckpoint(sftp, temporaryPath, buildCheckpoint(offset));
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

        // 并发流水写：多个 SFTP WRITE 同时在途，吞吐不再受单块 RTT 限制。
        // offset 只在连续块确认后推进，checkpoint 永远不超过真实落盘范围。
        const writeResult = await writePipelined(sftp, handle, trackedSource, offset, {
          chunkSize: CHUNK_SIZE,
          shouldCancel: () => task.canceled || task.paused,
          onAck: async (confirmedOffset) => {
            offset = confirmedOffset;
            markActivity();
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
              scheduleCheckpoint();
            }
          },
        });
        offset = writeResult.confirmedOffset;
        // 传输结束：停掉后台 checkpoint 并等在途写落地，避免提交/清理之后
        // 后台写又把 sidecar 重建出来（孤儿 meta）。
        checkpointStopped = true;
        await waitCheckpointIdle();
        if (shouldCommit && sourceSize > 0 && offset !== sourceSize) {
          throw new TransferError(
            `Upload incomplete: expected ${sourceSize} bytes, confirmed ${offset}`,
            'upload-incomplete',
            true,
          );
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
        // 保留源文件修改时间（Web 上传默认开启）；权限位浏览器 File 不提供，跳过。
        if (task.snapshot.preserveTimestamps !== false && sourceMtime > 0) {
          await callSftp(sftp, 'utimes', protocolDestination, sourceMtime, sourceMtime).catch(() => undefined);
        }
        return finish(task, 'completed', undefined, commitGuarantee);
      } catch (error) {
        checkpointStopped = true;
        if (Number.isFinite(error?.confirmedOffset)) {
          offset = Math.max(offset, Number(error.confirmedOffset));
        }
        await callSftp(sftp, 'close', handle).catch(() => undefined);
        // 用户取消后 writePipelined 在块边界抛 canceled；但客户端 abort/网络错误
        // 可能先以别的错误码断开请求——只要 task.canceled 已置位就统一按取消处理，
        // 避免与 WS 的 canceled 快照竞态、把取消显示成“失败”。
        const paused = task.paused && !task.canceled;
        const canceled = !paused && (error?.code === 'canceled' || task.canceled);
        if (paused) {
          // 用户暂停：保留远端 temp 与 checkpoint，回到 paused 等用户继续后从断点续传。
          // （与取消不同，取消会清理 temp/meta；暂停必须留住它们。）
          if (offset > 0) {
            await persistCheckpoint().catch(() => undefined);
          }
          return finish(task, 'paused');
        }
        if (canceled) {
          // 取消代表用户明确放弃本次上传，不保留远端 partial/meta；
          // 否则目录里会留下 .part 与 .meta 两个隐藏文件。
          // 先等后台 checkpoint 落地，避免删除后又被在途写重建。
          await waitCheckpointIdle();
          await removeRemoteQuiet(sftp, temporaryPath);
          await removeRemoteQuiet(sftp, checkpointRemotePath(temporaryPath));
        } else if (offset > 0) {
          // 失败/网络中断尽量落最终 checkpoint，便于重试续传。
          // persistCheckpoint 会先等后台单飞落地，保证 sidecar 不被旧偏移覆盖。
          await persistCheckpoint().catch(() => undefined);
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
      } finally {
        clearInterval(watchdog);
        // 显式收尾生成器，释放底层 request 迭代器；收尾失败不掩盖原始错误。
        try { await trackedSource.return?.(); } catch { /* ignore cleanup error */ }
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
      // 文件夹上传：relativePath 携带相对 remoteDirectory 的嵌套路径（含文件名），
      // 例如 "myfolder/sub/a.txt"。校验拒绝绝对路径与 '..' 逃逸；name 仍为 basename。
      let remotePath = posixPath.join(remoteDirectory, file.name);
      let ensureParents = false;
      if (file.relativePath != null && String(file.relativePath).trim() !== '') {
        const relativePath = String(file.relativePath).replace(/\\/g, '/');
        const segments = relativePath.split('/').filter((segment) => segment !== '' && segment !== '.');
        if (relativePath.startsWith('/') || segments.includes('..') || segments.length === 0) {
          throw new TransferError('Invalid relative upload path', 'invalid-path', false);
        }
        remotePath = posixPath.join(remoteDirectory, segments.join('/'));
        ensureParents = segments.length > 1;
      }
      const task = {
        clientId,
        canceled: false,
        paused: false,
        ensureParents,
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
      // 上传完成后是否回写源文件 mtime（Web 端默认开启；权限位浏览器不提供，跳过）。
      task.snapshot.preserveTimestamps = request.preserveTimestamps !== false;
      tasks.set(task.snapshot.taskId, task);
      emit(task);
      return task.snapshot;
    });
    schedulePersist();
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
    schedulePersist();
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
    if (!['failed', 'interrupted', 'canceled', 'skipped', 'paused'].includes(task.snapshot.status)) {
      throw new TransferError('Transfer is not retryable', 'conflict', false);
    }
    task.canceled = false;
    task.paused = false;

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
   * 暂停上传任务：保留远端 temp + checkpoint，供之后 resume 从断点续传。
   * - 队列中/等待冲突：没有在途请求，直接把状态切成 paused。
   * - 传输中：置 task.paused，writePipelined 会在块边界退出，上传处理器随后 finish('paused')。
   * 下载任务是前端 FSA 流式写盘，由前端 abort 后通过 /download-status 回报 paused。
   */
  function pause(clientId, request) {
    const task = tasks.get(request?.taskId);
    assertOwner(task, clientId);
    if (task.snapshot.status === 'committing') {
      throw new TransferError('Transfer commit is in progress', 'commit-in-progress', false);
    }
    if (isTerminal(task.snapshot.status)) {
      throw new TransferError('Transfer already finished', 'conflict', false);
    }
    if (task.snapshot.status === 'paused') return task.snapshot;
    task.paused = true;
    if (['queued', 'checking', 'waiting-conflict'].includes(task.snapshot.status)) {
      return update(task, (snapshot) => {
        snapshot.status = 'paused';
        snapshot.conflict = undefined;
      });
    }
    // 传输中：在途分片会在块边界停下，处理器会发 paused 快照。
    return task.snapshot;
  }

  /** 继续已暂停的任务：上传从远端 checkpoint 续传；下载重置为 queued 由前端重新驱动。 */
  async function resume(clientId, request) {
    const task = tasks.get(request?.taskId);
    assertOwner(task, clientId);
    if (task.snapshot.status !== 'paused') {
      throw new TransferError('Transfer is not paused', 'conflict', false);
    }
    task.paused = false;
    task.canceled = false;

    let resumeFrom = task.snapshot.transferredBytes || 0;
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
        resumeFrom = task.snapshot.transferredBytes || 0;
      }
    }

    return update(task, (snapshot) => {
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

    if (status === 'paused') {
      // 前端暂停下载：保留任务与本地 checkpoint，状态记为 paused（非终态），
      // 之后 /resume 或重试会把它重置为 queued 重新驱动 FSA 续传。
      if (!['queued', 'transferring', 'paused'].includes(task.snapshot.status)) {
        return task.snapshot;
      }
      return update(task, (snapshot) => {
        snapshot.status = 'paused';
        if (Number.isFinite(transferredBytes) && transferredBytes >= 0) {
          snapshot.transferredBytes = transferredBytes;
        }
        if (Number.isFinite(totalBytes) && totalBytes >= 0) {
          snapshot.totalBytes = totalBytes;
        }
        snapshot.completedAt = undefined;
        snapshot.error = undefined;
      });
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
    schedulePersist();
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
    pause,
    reportDownload,
    resolveConflict,
    resume,
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
