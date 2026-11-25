'use strict';

/**
 * 独立 SSH 密钥库（Key Vault）：
 * - 统一管理私钥（复用 secret-store 的 AES-256-GCM 加密落盘，列表接口绝不回传明文私钥）
 * - 支持在线生成 Ed25519 / RSA 密钥对并导出标准 OpenSSH 公钥与 SHA-256 指纹
 * - 支持将公钥安全部署到远端 ~/.ssh/authorized_keys（幂等，自动设置 700/600 权限）
 * - 建连前统一解析连接及跳板机引用的 keyId / jumpHost.connectionId
 */

const crypto = require('node:crypto');
const { utils: sshUtils } = require('ssh2');
const { execCommand } = require('./ssh-exec.cjs');

/** 将 OpenSSH 格式公钥或 PEM 私钥解析出算法、公钥文本与 SHA-256 指纹。 */
function inspectPrivateKey(privateKey, passphrase) {
  const parsed = sshUtils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    throw new Error(`Invalid private key: ${parsed.message}`);
  }
  const keyObj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!keyObj || typeof keyObj.getPublicSSH !== 'function') {
    throw new Error('Unable to parse SSH key');
  }
  const pubBuf = keyObj.getPublicSSH();
  const algorithm = keyObj.type || 'unknown';
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(pubBuf).digest('base64').replace(/=+$/, '')}`;
  const publicKey = `${algorithm} ${pubBuf.toString('base64')}`;
  return { algorithm, fingerprint, publicKey };
}

/** 构造 SSH wire-format 字符串（uint32 长度前缀 + payload）。 */
function sshWireBuf(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** 构造 SSH mpint（正大整数，最高位为 1 时前置 0x00）。 */
function sshMpint(buf) {
  let slice = buf;
  while (slice.length > 1 && slice[0] === 0) slice = slice.subarray(1);
  if (slice.length > 0 && (slice[0] & 0x80)) {
    slice = Buffer.concat([Buffer.from([0x00]), slice]);
  }
  return sshWireBuf(slice);
}

/** 从 Node KeyObject（ed25519 或 rsa）生成标准 OpenSSH 公钥行。 */
function exportOpenSshPublicKey(publicKeyObj, comment = 'ai-ssh-client') {
  const type = publicKeyObj.asymmetricKeyType;
  let pubBlob;
  let alg;
  if (type === 'ed25519') {
    alg = 'ssh-ed25519';
    // SPKI DER 末尾 32 字节即 Ed25519 原始公钥
    const spki = publicKeyObj.export({ type: 'spki', format: 'der' });
    const rawKey = spki.subarray(spki.length - 32);
    pubBlob = Buffer.concat([sshWireBuf(Buffer.from(alg)), sshWireBuf(rawKey)]);
  } else if (type === 'rsa') {
    alg = 'ssh-rsa';
    const jwk = publicKeyObj.export({ format: 'jwk' });
    const e = Buffer.from(jwk.e, 'base64url');
    const n = Buffer.from(jwk.n, 'base64url');
    pubBlob = Buffer.concat([sshWireBuf(Buffer.from(alg)), sshMpint(e), sshMpint(n)]);
  } else {
    throw new Error(`Unsupported key algorithm: ${type}`);
  }
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}`;
  const safeComment = String(comment || 'ai-ssh-client').replace(/[\r\n]/g, ' ').trim();
  const publicKey = `${alg} ${pubBlob.toString('base64')}${safeComment ? ` ${safeComment}` : ''}`;
  return { algorithm: alg, fingerprint, publicKey };
}

/**
 * 在线生成 SSH 密钥对（ed25519 或 rsa）。
 * 私钥以 PKCS#8 PEM（ed25519）/ PKCS#1 PEM（rsa）输出，ssh2 可直接加载。
 */
function generateSshKeyPair({ name = 'Generated Key', algorithm = 'ed25519', passphrase = '' } = {}) {
  const alg = String(algorithm || 'ed25519').toLowerCase();
  const cipherOpts = passphrase
    ? { cipher: 'aes-256-cbc', passphrase }
    : {};

  let pair;
  if (alg === 'ed25519') {
    pair = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', ...cipherOpts },
    });
  } else if (alg === 'rsa' || alg === 'rsa-4096' || alg === 'rsa-2048') {
    const modulusLength = alg === 'rsa-2048' ? 2048 : 4096;
    pair = crypto.generateKeyPairSync('rsa', {
      modulusLength,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', ...cipherOpts },
    });
  } else {
    throw new Error(`Unsupported algorithm: ${algorithm} (supported: ed25519, rsa)`);
  }

  const meta = exportOpenSshPublicKey(pair.publicKey, name);
  return {
    id: `key-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    name: String(name || 'Generated Key').trim() || 'Generated Key',
    algorithm: meta.algorithm,
    fingerprint: meta.fingerprint,
    publicKey: meta.publicKey,
    privateKey: pair.privateKey,
    passphrase: passphrase || undefined,
    createdAt: Date.now(),
  };
}

/** 列表返回时脱敏：隐藏 privateKey 与 passphrase 明文。 */
function summarizeSshKey(record) {
  return {
    id: record.id,
    name: record.name,
    algorithm: record.algorithm || 'unknown',
    fingerprint: record.fingerprint || '',
    publicKey: record.publicKey || '',
    hasPassphrase: Boolean(record.passphrase),
    createdAt: Number(record.createdAt) || Date.now(),
  };
}

/**
 * 解析一条 SSH 连接的实际凭据：
 * 1. 若配置了 keyId，从 store.sshKeys 补全 privateKey / passphrase；
 * 2. 若跳板机配置了 connectionId，从 store.connections 补全该跳的主机/端口/凭据（并递归解析其 keyId）。
 */
function resolveConnectionCredentials(connection, store) {
  if (!connection || typeof connection !== 'object') return connection;
  const keys = Array.isArray(store?.sshKeys) ? store.sshKeys : [];
  const savedConnections = Array.isArray(store?.connections) ? store.connections : [];
  const keyMap = new Map(keys.map((item) => [item.id, item]));
  const connMap = new Map(savedConnections.map((item) => [item.id, item]));

  const resolved = { ...connection };
  if (resolved.keyId && keyMap.has(resolved.keyId)) {
    const key = keyMap.get(resolved.keyId);
    if (!resolved.privateKey && key.privateKey) {
      resolved.privateKey = key.privateKey;
      if (!resolved.passphrase && key.passphrase) {
        resolved.passphrase = key.passphrase;
      }
    }
  }

  if (Array.isArray(resolved.jumpHosts) && resolved.jumpHosts.length > 0) {
    resolved.jumpHosts = resolved.jumpHosts.map((hop) => {
      if (!hop || typeof hop !== 'object') return hop;
      let nextHop = { ...hop };
      if (nextHop.connectionId && connMap.has(nextHop.connectionId)) {
        const ref = connMap.get(nextHop.connectionId);
        nextHop = {
          ...nextHop,
          host: nextHop.host || ref.host,
          port: nextHop.port || ref.port || 22,
          username: nextHop.username || ref.username,
          password: nextHop.password || ref.password,
          keyId: nextHop.keyId || ref.keyId,
          privateKey: nextHop.privateKey || ref.privateKey,
          passphrase: nextHop.passphrase || ref.passphrase,
        };
      }
      if (nextHop.keyId && !nextHop.privateKey && keyMap.has(nextHop.keyId)) {
        const key = keyMap.get(nextHop.keyId);
        nextHop.privateKey = key.privateKey;
        if (!nextHop.passphrase && key.passphrase) {
          nextHop.passphrase = key.passphrase;
        }
      }
      return nextHop;
    });
  }

  return resolved;
}

/**
 * 将单条 OpenSSH 公钥部署到远端 `~/.ssh/authorized_keys`（幂等，自动校正权限）。
 */
async function deployPublicKeyToServer(client, publicKey) {
  const trimmed = String(publicKey || '').trim().replace(/[\r\n]+/g, ' ');
  if (!trimmed || !/^(ssh-|ecdsa-sha2-|sk-)/.test(trimmed)) {
    throw new Error('Invalid OpenSSH public key');
  }
  const b64 = Buffer.from(trimmed, 'utf8').toString('base64');
  // 用 base64 传输避免任何 shell 引号/注入问题；grep -Fqx 检查重复
  const script = [
    'set -e',
    'umask 077',
    'mkdir -p ~/.ssh',
    'chmod 700 ~/.ssh',
    'touch ~/.ssh/authorized_keys',
    'chmod 600 ~/.ssh/authorized_keys',
    `KEY=$(printf '%s' '${b64}' | base64 -d)`,
    'if grep -Fqx "$KEY" ~/.ssh/authorized_keys 2>/dev/null; then',
    '  echo "ALREADY_PRESENT"',
    'else',
    '  printf "\\n%s\\n" "$KEY" >> ~/.ssh/authorized_keys',
    '  echo "DEPLOYED"',
    'fi',
  ].join('\n');

  const result = await execCommand(client, script, { timeoutMs: 15000 });
  if (result.exitCode !== 0) {
    throw new Error(String(result.stderr || result.output || 'Failed to deploy public key').trim());
  }
  const alreadyPresent = String(result.output || '').includes('ALREADY_PRESENT');
  return { deployed: true, alreadyPresent };
}

module.exports = {
  inspectPrivateKey,
  generateSshKeyPair,
  summarizeSshKey,
  resolveConnectionCredentials,
  deployPublicKeyToServer,
};
