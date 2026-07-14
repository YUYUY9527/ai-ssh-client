const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');

const {
  createSftpTransferService,
  temporaryRemotePath,
  checkpointRemotePath,
} = require('../server/sftp-transfer.cjs');

function missing() {
  return Object.assign(new Error('missing'), { code: 2 });
}

/** 简易内存 SFTP：支持 open/write/read stream/rename/unlink/lstat。 */
function createSftp(files = new Map()) {
  const handles = new Map();
  let handleSeq = 0;
  return {
    lstat(remotePath, callback) {
      if (!files.has(remotePath)) {
        callback(missing());
        return;
      }
      callback(null, { size: files.get(remotePath).length });
    },
    open(remotePath, flags, callback) {
      const id = `h${handleSeq += 1}`;
      if (flags === 'w' || flags === 'w+') {
        handles.set(id, { path: remotePath, buffer: Buffer.alloc(0) });
      } else if (flags === 'r' || flags === 'r+') {
        if (!files.has(remotePath) && flags === 'r') {
          callback(missing());
          return;
        }
        handles.set(id, {
          path: remotePath,
          buffer: Buffer.from(files.get(remotePath) || Buffer.alloc(0)),
        });
      } else {
        handles.set(id, { path: remotePath, buffer: Buffer.from(files.get(remotePath) || Buffer.alloc(0)) });
      }
      callback(null, id);
    },
    write(handle, data, offset, length, position, callback) {
      const entry = handles.get(handle);
      assert.ok(entry);
      assert.equal(offset, 0);
      const chunk = data.subarray(offset, offset + length);
      if (position === entry.buffer.length) {
        entry.buffer = Buffer.concat([entry.buffer, chunk]);
      } else if (position < entry.buffer.length) {
        const next = Buffer.alloc(Math.max(entry.buffer.length, position + chunk.length));
        entry.buffer.copy(next);
        chunk.copy(next, position);
        entry.buffer = next;
      } else {
        const next = Buffer.alloc(position + chunk.length);
        entry.buffer.copy(next);
        chunk.copy(next, position);
        entry.buffer = next;
      }
      callback(null, position + chunk.length);
    },
    close(handle, callback) {
      const entry = handles.get(handle);
      if (entry) {
        files.set(entry.path, entry.buffer);
        handles.delete(handle);
      }
      callback(null);
    },
    rename(source, destination, callback) {
      if (!files.has(source)) {
        callback(missing());
        return;
      }
      files.set(destination, files.get(source));
      files.delete(source);
      callback(null);
    },
    unlink(remotePath, callback) {
      files.delete(remotePath);
      callback(null);
    },
    createReadStream(remotePath) {
      const stream = new EventEmitter();
      stream.readable = true;
      queueMicrotask(() => {
        if (!files.has(remotePath)) {
          stream.emit('error', missing());
          return;
        }
        stream.emit('data', files.get(remotePath));
        stream.emit('end');
      });
      return stream;
    },
    createWriteStream(remotePath) {
      const stream = new EventEmitter();
      const chunks = [];
      stream.writable = true;
      stream.end = (data) => {
        if (data) chunks.push(Buffer.from(data));
        files.set(remotePath, Buffer.concat(chunks));
        queueMicrotask(() => stream.emit('close'));
      };
      stream.write = (data) => {
        chunks.push(Buffer.from(data));
        return true;
      };
      stream.on = stream.addListener.bind(stream);
      return stream;
    },
  };
}

function requestLike(chunks, headers = {}) {
  const stream = Readable.from(chunks);
  stream.headers = headers;
  return stream;
}

async function main() {
  const events = [];
  const remoteFiles = new Map();
  const sftp = createSftp(remoteFiles);
  const service = createSftpTransferService({
    getSftp: async () => sftp,
    emitEvent: (clientId, type, payload) => events.push({ clientId, type, payload }),
  });

  const created = service.startUpload('client-a', {
    connectionId: 'connection-a',
    remoteDirectory: '/uploads',
    files: [{ name: 'report.txt', ref: 'web-file:report', size: 5 }],
  });
  const task = created.tasks[0];
  await service.upload('client-a', task.taskId, requestLike([Buffer.from('hello')], {
    'content-length': '5',
    'x-sftp-source-size': '5',
    'x-sftp-source-mtime': '100',
  }));

  assert.equal(remoteFiles.get('/uploads/report.txt').toString(), 'hello');
  const completed = service.list('client-a').tasks[0];
  assert.equal(completed.status, 'completed');
  assert.equal(completed.progress, 100);
  assert.equal(completed.commitGuarantee, 'atomic-create');
  assert.ok(events.every((event) => event.clientId === 'client-a'));

  remoteFiles.set('/uploads/existing.txt', Buffer.from('old'));
  const conflicted = service.startUpload('client-a', {
    connectionId: 'connection-a',
    remoteDirectory: '/uploads',
    files: [{ name: 'existing.txt', ref: 'web-file:existing', size: 3 }],
  }).tasks[0];
  await assert.rejects(
    service.upload('client-a', conflicted.taskId, requestLike([Buffer.from('new')], {
      'x-sftp-source-size': '3',
      'x-sftp-source-mtime': '1',
    })),
    /Destination already exists/,
  );
  assert.equal(service.list('client-a').tasks.find((item) => item.taskId === conflicted.taskId).status, 'waiting-conflict');
  assert.throws(
    () => service.resolveConflict('client-b', {
      taskId: conflicted.taskId,
      attempt: 1,
      policy: 'overwrite',
    }),
    /not found/,
  );
  service.resolveConflict('client-a', {
    taskId: conflicted.taskId,
    attempt: 1,
    policy: 'overwrite',
  });
  await service.upload('client-a', conflicted.taskId, requestLike([Buffer.from('new')], {
    'x-sftp-source-size': '3',
    'x-sftp-source-mtime': '1',
  }));
  assert.equal(remoteFiles.get('/uploads/existing.txt').toString(), 'new');
  assert.equal(
    service.list('client-a').tasks.find((item) => item.taskId === conflicted.taskId).commitGuarantee,
    'best-effort-replace',
  );

  remoteFiles.set('/uploads/a.txt', Buffer.from('a'));
  remoteFiles.set('/uploads/b.txt', Buffer.from('b'));
  const batch = service.startUpload('client-a', {
    connectionId: 'connection-a',
    remoteDirectory: '/uploads',
    files: [
      { name: 'a.txt', ref: 'web-file:a', size: 1 },
      { name: 'b.txt', ref: 'web-file:b', size: 1 },
    ],
  }).tasks;
  await assert.rejects(
    service.upload('client-a', batch[0].taskId, requestLike([Buffer.from('1')])),
    /Destination already exists/,
  );
  await assert.rejects(
    service.upload('client-a', batch[1].taskId, requestLike([Buffer.from('2')])),
    /Destination already exists/,
  );
  service.resolveConflict('client-a', {
    taskId: batch[0].taskId,
    attempt: 1,
    policy: 'skip',
    applyToBatch: true,
  });
  assert.equal(
    service.list('client-a').tasks.find((item) => item.taskId === batch[0].taskId).status,
    'queued',
  );
  assert.equal(
    service.list('client-a').tasks.find((item) => item.taskId === batch[1].taskId).conflictPolicy,
    'skip',
  );

  // 续传：先写入 partial + checkpoint，再以 offset 续传。
  const resumeTask = service.startUpload('client-a', {
    connectionId: 'connection-a',
    remoteDirectory: '/uploads',
    files: [{ name: 'resume.bin', ref: 'web-file:resume', size: 10 }],
  }).tasks[0];
  const tempPath = temporaryRemotePath('/uploads/resume.bin', resumeTask.taskId);
  const metaPath = checkpointRemotePath(tempPath);
  remoteFiles.set(tempPath, Buffer.from('hello'));
  remoteFiles.set(metaPath, Buffer.from(JSON.stringify({
    taskId: resumeTask.taskId,
    sourceSize: 10,
    sourceMtime: 42,
    sourceHead: 'aa',
    sourceTail: 'bb',
    totalBytes: 10,
    confirmedOffset: 5,
    destinationPath: '/uploads/resume.bin',
  })));

  service.cancel('client-a', { taskId: resumeTask.taskId });
  // queued cancel 会直接终态；改成 failed 再 retry 以模拟中断恢复。
  const listed = service.list('client-a').tasks.find((item) => item.taskId === resumeTask.taskId);
  if (listed.status !== 'canceled') {
    // 若仍活动则强制取消完成
  }
  // 重新排队：手动将状态改为 canceled 后 retry
  const retried = await service.retry('client-a', { taskId: resumeTask.taskId });
  assert.equal(retried.resumedFrom, 5);
  await service.upload('client-a', resumeTask.taskId, requestLike([Buffer.from('world')], {
    'x-sftp-source-size': '10',
    'x-sftp-source-mtime': '42',
    'x-sftp-source-head': 'aa',
    'x-sftp-source-tail': 'bb',
    'x-sftp-resume-offset': '5',
  }));
  assert.equal(remoteFiles.get('/uploads/resume.bin').toString(), 'helloworld');
  assert.equal(
    service.list('client-a').tasks.find((item) => item.taskId === resumeTask.taskId).status,
    'completed',
  );

  // 源变化应失败并清理 partial。
  const changed = service.startUpload('client-a', {
    connectionId: 'connection-a',
    remoteDirectory: '/uploads',
    files: [{ name: 'changed.bin', ref: 'web-file:changed', size: 4 }],
  }).tasks[0];
  const changedTemp = temporaryRemotePath('/uploads/changed.bin', changed.taskId);
  remoteFiles.set(changedTemp, Buffer.from('ab'));
  remoteFiles.set(checkpointRemotePath(changedTemp), Buffer.from(JSON.stringify({
    taskId: changed.taskId,
    sourceSize: 4,
    sourceMtime: 1,
    totalBytes: 4,
    confirmedOffset: 2,
    destinationPath: '/uploads/changed.bin',
  })));
  await assert.rejects(
    service.upload('client-a', changed.taskId, requestLike([Buffer.from('xx')], {
      'x-sftp-source-size': '4',
      'x-sftp-source-mtime': '999',
      'x-sftp-resume-offset': '2',
    })),
    /Source file changed/,
  );

  console.log('sftp transfer tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
