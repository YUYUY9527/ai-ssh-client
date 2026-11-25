'use strict';

/**
 * 纯 Node.js RFC 6238 TOTP（基于 HMAC-SHA1，30s 步长，6 位数字），零外部依赖。
 * 供 Web 网关登录双因素认证（Google Authenticator / 1Password / Bitwarden 兼容）使用。
 */

const crypto = require('node:crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SEC = 30;
const TOTP_DIGITS = 6;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 生成 20 字节（160 位）Base32 TOTP 密钥。 */
function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** 计算给定时间点对应的 6 位 TOTP 验证码。 */
function generateTotpCode(secret, nowMs = Date.now(), stepSec = TOTP_STEP_SEC) {
  const key = base32Decode(secret);
  if (key.length === 0) throw new Error('Invalid TOTP secret');
  const counter = Math.floor(nowMs / 1000 / stepSec);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binCode % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

/** 校验用户输入的 6 位 TOTP 验证码（默认允许 ±1 个时间窗口，即 ±30s 时钟漂移）。 */
function verifyTotpCode(secret, code, options = {}) {
  const cleanCode = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) return false;
  const nowMs = options.nowMs ?? Date.now();
  const window = options.window ?? 1;
  const stepSec = options.stepSec ?? TOTP_STEP_SEC;
  const codeBuf = Buffer.from(cleanCode);

  for (let delta = -window; delta <= window; delta += 1) {
    const candidate = generateTotpCode(secret, nowMs + delta * stepSec * 1000, stepSec);
    const candBuf = Buffer.from(candidate);
    if (candBuf.length === codeBuf.length && crypto.timingSafeEqual(candBuf, codeBuf)) {
      return true;
    }
  }
  return false;
}

/** 构造标准 otpauth:// URI，供认证器 App 导入。 */
function buildOtpAuthUri({ secret, account = 'admin', issuer = 'AI SSH Client' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  base32Encode,
  base32Decode,
  generateTotpSecret,
  generateTotpCode,
  verifyTotpCode,
  buildOtpAuthUri,
};
