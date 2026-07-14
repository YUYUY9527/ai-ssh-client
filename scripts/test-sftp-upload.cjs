const assert = require('node:assert/strict');

const { writeSftpFile } = require('../server/sftp-upload.cjs');

async function main() {
  const buffer = Buffer.alloc(70 * 1024, 1);
  const handle = Buffer.from('handle');
  const writes = [];
  const progress = [];
  let closed = false;
  await writeSftpFile({
    open(remotePath, flags, callback) {
      assert.equal(remotePath, '/tmp/upload.txt');
      assert.equal(flags, 'w');
      callback(null, handle);
    },
    write(receivedHandle, data, offset, length, position, callback) {
      assert.equal(receivedHandle, handle);
      assert.equal(data, buffer);
      const written = Math.max(1, Math.floor(length / 2));
      writes.push({ offset, length, position, written });
      callback(null, offset + written);
    },
    close(receivedHandle, callback) {
      assert.equal(receivedHandle, handle);
      closed = true;
      callback(null);
    },
  }, '/tmp/upload.txt', buffer, (written, total) => progress.push({ written, total }));

  assert.ok(writes.length > 1);
  assert.equal(writes[0].offset, 0);
  assert.equal(writes[0].position, 0);
  for (let index = 1; index < writes.length; index += 1) {
    assert.equal(writes[index].offset, writes[index - 1].offset + writes[index - 1].written);
    assert.equal(writes[index].position, writes[index].offset);
  }
  assert.equal(progress.at(-1).written, buffer.length);
  assert.equal(progress.at(-1).total, buffer.length);
  assert.equal(closed, true);

  const failure = new Error('write failed');
  let closedAfterFailure = false;
  await assert.rejects(writeSftpFile({
    open(_remotePath, _flags, callback) {
      callback(null, handle);
    },
    write(_handle, _data, _offset, _length, _position, callback) {
      callback(failure);
    },
    close(_handle, callback) {
      closedAfterFailure = true;
      callback(null);
    },
  }, '/tmp/upload.txt', buffer), failure);
  assert.equal(closedAfterFailure, true);

  const invalidWrite = writeSftpFile({
    open(_remotePath, _flags, callback) {
      callback(null, handle);
    },
    write(_handle, _data, _offset, _length, _position, callback) {
      callback(null, _offset);
    },
    close(_handle, callback) {
      callback(null);
    },
  }, '/tmp/upload.txt', buffer);
  await assert.rejects(invalidWrite, /Invalid SFTP write result/);

  console.log('sftp upload tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
