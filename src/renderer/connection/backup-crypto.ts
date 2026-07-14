/**
 * Password-based AES-GCM helpers for optional encrypted backup packages.
 * Uses Web Crypto so both desktop webview and pure web can share the path.
 */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  // 拷贝到独立 ArrayBuffer，满足 BufferSource 类型约束
  const saltBuffer = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 120_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypts a plain backup object into an encrypted package. */
export async function encryptBackupPayload(
  payload: Record<string, unknown>,
  password: string,
): Promise<Record<string, unknown>> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const ivBuffer = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBuffer }, key, plain);
  return {
    version: 'ai-ssh-client-1',
    encrypted: true,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(cipher)),
  };
}

/** Decrypts an encrypted package back to the original backup object. */
export async function decryptBackupPayload(
  packageData: Record<string, unknown>,
  password: string,
): Promise<Record<string, unknown>> {
  const salt = base64ToBytes(String(packageData.salt || ''));
  const iv = base64ToBytes(String(packageData.iv || ''));
  const ciphertext = base64ToBytes(String(packageData.ciphertext || ''));
  if (!salt.length || !iv.length || !ciphertext.length) {
    throw new Error('Invalid encrypted backup package');
  }
  const key = await deriveKey(password, salt);
  const ivBuffer = iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength) as ArrayBuffer;
  const cipherBuffer = ciphertext.buffer.slice(
    ciphertext.byteOffset,
    ciphertext.byteOffset + ciphertext.byteLength,
  ) as ArrayBuffer;
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuffer },
    key,
    cipherBuffer,
  );
  const text = new TextDecoder().decode(plain);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return parsed;
}

export function isEncryptedBackup(data: unknown): data is Record<string, unknown> {
  return Boolean(
    data
    && typeof data === 'object'
    && (data as { encrypted?: boolean }).encrypted === true
    && typeof (data as { ciphertext?: string }).ciphertext === 'string',
  );
}
