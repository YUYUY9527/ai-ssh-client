const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * 密文标记。带前缀的字符串才会被解密，因此历史明文数据可以无缝共存：
 * 读取时原样返回，下一次写盘时自动加密（渐进式迁移，无需手动处理旧文件）。
 */
const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
/** 从 WEB_AUTH_PASSWORD 派生密钥时使用的固定盐（scrypt 需要盐，此处无需随机）。 */
const ENV_SALT = 'ai-ssh-client-web-secret-v1';
/** 密钥文件名（位于 data 目录，权限 0600）。 */
const KEY_FILE = 'secret.key';

/** 需要加密落盘的字段：连接凭据 + AI 供应商密钥。 */
const CONNECTION_SECRET_FIELDS = ['password', 'privateKey', 'passphrase'];
const PROVIDER_SECRET_FIELDS = ['apiKey'];

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * 凭据加解密（AES-256-GCM）。
 *
 * 威胁模型（务必如实理解，不要高估）：
 * - 环境变量模式（设置了 WEB_AUTH_PASSWORD）：密钥由部署方掌握，**不落盘**。
 *   拿到数据卷也无法解密，防护最强。
 * - 文件模式（默认）：密钥随机生成并存放在同目录的 secret.key（0600）。
 *   可防「config.json 被单独拷走/误提交/进了备份或日志」，但**不能防**
 *   能读取整个数据目录的攻击者——密钥就在旁边。这是有意的取舍：
 *   网关必须在无人值守时自行解密凭据才能建立 SSH 连接。
 *
 * 无论哪种模式，宿主机被完全攻陷都不在防护范围内；README 已如实说明。
 */
function createSecretStore({ dataDir, passphrase } = {}) {
  let cachedKey = null;
  let warnedDecryptFailure = false;

  const envPassword = typeof passphrase === 'string' && passphrase.trim()
    ? passphrase.trim()
    : '';

  /** 密钥来源：env 模式从口令派生；否则读写 data/secret.key。 */
  function loadKey() {
    if (cachedKey) {
      return cachedKey;
    }
    if (envPassword) {
      cachedKey = crypto.scryptSync(envPassword, ENV_SALT, KEY_LEN);
      return cachedKey;
    }

    const keyPath = path.join(String(dataDir || '.'), KEY_FILE);
    try {
      const existing = fs.readFileSync(keyPath);
      if (existing.length === KEY_LEN) {
        cachedKey = existing;
        return cachedKey;
      }
    } catch {
      // 首次运行或文件不可读：下面重新生成。
    }

    const generated = crypto.randomBytes(KEY_LEN);
    try {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, generated, { mode: 0o600 });
    } catch (error) {
      // 无法落盘时仍在内存中保留密钥：本次进程可正常读写，
      // 但下次启动会生成新密钥，导致已有密文无法解密。
      console.warn(`[secret-store] 无法写入密钥文件 ${keyPath}: ${error.message}`);
    }
    cachedKey = generated;
    return cachedKey;
  }

  function encrypt(plain) {
    if (typeof plain !== 'string' || plain === '') {
      return plain;
    }
    // 幂等：已加密的值不再套一层（避免重复写盘时层层包裹）。
    if (isEncrypted(plain)) {
      return plain;
    }
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGORITHM, loadKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  /**
   * 解密。明文（旧数据）原样返回；密文损坏或密钥不匹配时返回 null，
   * 并只在首次失败时告警一次，避免每读一次配置就刷屏。
   */
  function decrypt(value) {
    if (!isEncrypted(value)) {
      return value;
    }
    const parts = value.slice(PREFIX.length).split(':');
    if (parts.length !== 3) {
      return failDecrypt('密文格式不正确');
    }
    try {
      const [ivB64, tagB64, dataB64] = parts;
      const decipher = crypto.createDecipheriv(
        ALGORITHM,
        loadKey(),
        Buffer.from(ivB64, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(dataB64, 'base64')),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    } catch {
      return failDecrypt('密钥不匹配或数据已损坏');
    }
  }

  function failDecrypt(reason) {
    if (!warnedDecryptFailure) {
      warnedDecryptFailure = true;
      console.warn(
        `[secret-store] 凭据解密失败（${reason}）。`
        + '常见原因：改用/更换了 WEB_AUTH_PASSWORD，或 secret.key 丢失或被替换。'
        + '受影响连接的密码会显示为空，需在界面上重新填写。',
      );
    }
    return null;
  }

  /** 把一组对象里的指定字段加密（返回浅拷贝，不修改入参）。 */
  function mapFields(items, fields, transform) {
    if (!Array.isArray(items)) {
      return items;
    }
    return items.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }
      const next = { ...item };
      fields.forEach((field) => {
        if (next[field] !== undefined) {
          next[field] = transform(next[field]);
        }
      });
      return next;
    });
  }

  /** 写盘前：加密连接凭据与 AI 密钥。 */
  function encryptStore(store) {
    if (!store || typeof store !== 'object') {
      return store;
    }
    return {
      ...store,
      connections: mapFields(store.connections, CONNECTION_SECRET_FIELDS, encrypt),
      aiProviders: mapFields(store.aiProviders, PROVIDER_SECRET_FIELDS, encrypt),
    };
  }

  /** 读盘后：解密（历史明文原样保留，等待下次写盘时加密）。 */
  function decryptStore(store) {
    if (!store || typeof store !== 'object') {
      return store;
    }
    return {
      ...store,
      connections: mapFields(store.connections, CONNECTION_SECRET_FIELDS, decrypt),
      aiProviders: mapFields(store.aiProviders, PROVIDER_SECRET_FIELDS, decrypt),
    };
  }

  return {
    encrypt,
    decrypt,
    encryptStore,
    decryptStore,
    isEncrypted,
    keySource: envPassword ? 'env' : 'file',
    /** 仅供测试：丢弃缓存，强制重新加载密钥。 */
    resetCache: () => {
      cachedKey = null;
      warnedDecryptFailure = false;
    },
  };
}

module.exports = {
  createSecretStore,
  isEncrypted,
  PREFIX,
  KEY_FILE,
  CONNECTION_SECRET_FIELDS,
  PROVIDER_SECRET_FIELDS,
};
