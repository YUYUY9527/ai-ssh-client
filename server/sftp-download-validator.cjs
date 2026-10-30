const crypto = require('node:crypto');

/** 参与指纹计算的头/尾边缘字节数（各 64 KiB）。 */
const EDGE_BYTES = 64 * 1024;

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 生成内容感知的强 ETag。
 *
 * 仅凭 size + mtime（秒级）无法区分“同一秒内、同样大小”的重写，会让服务端对
 * 过期的 If-Range 误判为可续传，返回 206 把旧前缀拼到新后缀上。这里额外混入
 * 文件头/尾各 64KiB 的完整 SHA-256，能可靠识别首尾内容变化。
 *
 * size<=0、缺少 head/tail 哈希（例如读取失败）时返回空串，调用方据此不下发 ETag。
 *
 * @param {number} size 文件字节数
 * @param {number} mtimeSeconds ssh2 stat 的 mtime（秒）
 * @param {string} headHex 头部边缘的 SHA-256 十六进制摘要
 * @param {string} tailHex 尾部边缘的 SHA-256 十六进制摘要
 * @returns {string}
 */
function buildDownloadEtag(size, mtimeSeconds, headHex, tailHex) {
  const total = Number(size);
  if (!Number.isFinite(total) || total <= 0) return '';
  if (!headHex || !tailHex) return '';
  const mtime = Math.floor(Number(mtimeSeconds) || 0);
  return `"${total}-${mtime}-${headHex}-${tailHex}"`;
}

function readRange(sftp, remotePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const stream = sftp.createReadStream(remotePath, { start, end });
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * 计算远端文件头/尾各 min(64KiB, size) 字节的 SHA-256。
 *
 * - size<=0：返回 { head:'', tail:'' }；
 * - size<=64KiB：整体只读一次，head/tail 使用同一份摘要；
 * - 大文件：分别以 `{start,end}`（ssh2 的 end 为闭区间）读取首段与尾段。
 *
 * @param {any} sftp ssh2 SFTP 会话
 * @param {string} remotePath 远端文件路径
 * @param {number} size 文件字节数
 * @returns {Promise<{head: string, tail: string}>}
 */
async function readSftpFileEdges(sftp, remotePath, size) {
  const total = Number(size) || 0;
  if (total <= 0) return { head: '', tail: '' };

  if (total <= EDGE_BYTES) {
    const data = await readRange(sftp, remotePath, 0, total - 1);
    const digest = sha256Hex(data);
    return { head: digest, tail: digest };
  }

  const headBuf = await readRange(sftp, remotePath, 0, EDGE_BYTES - 1);
  const tailBuf = await readRange(sftp, remotePath, total - EDGE_BYTES, total - 1);
  return { head: sha256Hex(headBuf), tail: sha256Hex(tailBuf) };
}

module.exports = {
  EDGE_BYTES,
  buildDownloadEtag,
  readSftpFileEdges,
};
