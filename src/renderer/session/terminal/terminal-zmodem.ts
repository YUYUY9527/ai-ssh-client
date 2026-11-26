/**
 * ZMODEM (rz / sz) 触发检测与 SFTP 桥接工具。
 *
 * Web 终端走 UTF-8 文本通道，原始二进制 ZMODEM 帧会被 UTF-8 解码破坏并导致终端刷屏卡死。
 * 本模块检测到远端 `sz`（ZRQINIT: `**\x18B00`）或 `rz`（ZRINIT: `**\x18B01`）握手后：
 * 1) 立刻发送标准 ZMODEM 取消序列（5×CAN + 5×BS）让远端 rz/sz 干净退出；
 * 2) 交由前端直接走 SFTP 完成无损二进制上传（rz）或下载（sz）。
 */

export type ZmodemTriggerKind = 'rz' | 'sz';

// 标准 ZMODEM 帧头前导：ZPAD ZPAD ZDLE ZHEX + 帧类型（00=ZRQINIT 远端发文件 sz；01=ZRINIT 远端收文件 rz）
const ZMODEM_SZ_HEADER = '**\x18B00';
const ZMODEM_RZ_HEADER = '**\x18B01';

/** 标准 ZMODEM 取消序列：5 个 CAN (\x18) + 5 个退格 (\x08) + 回车。 */
export const ZMODEM_CANCEL_SEQUENCE = '\x18\x18\x18\x18\x18\x08\x08\x08\x08\x08\r';

export interface ZmodemDetectionResult {
  kind: ZmodemTriggerKind | null;
  cleanedChunk: string;
}

/**
 * 检测输出分片中是否包含 ZMODEM 握手头，并剥离不可读的 ZMODEM 帧头避免污染终端显示。
 */
export function detectZmodemSequence(chunk: string): ZmodemDetectionResult {
  if (!chunk || !chunk.includes('\x18B0')) {
    return { kind: null, cleanedChunk: chunk };
  }
  let kind: ZmodemTriggerKind | null = null;
  if (chunk.includes(ZMODEM_SZ_HEADER)) {
    kind = 'sz';
  } else if (chunk.includes(ZMODEM_RZ_HEADER)) {
    kind = 'rz';
  }
  if (!kind) {
    return { kind: null, cleanedChunk: chunk };
  }
  // 移除握手帧文本（如 `rz\r**\x18B00000000000000\r\n`）
  const cleanedChunk = chunk
    .replace(/(?:rz\r?)?\*\*\x18B0[01][0-9a-fA-F]{10,20}\r?\n?\x11?/g, '');
  return { kind, cleanedChunk };
}

/**
 * 从用户最近提交的 `sz ...` 命令行中解析出要下载的文件名列表（跳过 -y/-b/-e 等选项）。
 */
export function parseSzCommandFiles(commandLine: string): string[] {
  const trimmed = String(commandLine || '').trim();
  if (!trimmed) return [];
  const tokens = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  if (tokens.length < 2) return [];
  const cmdName = (tokens[0] || '').replace(/^.*\//, '');
  if (cmdName !== 'sz') return [];
  const files: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const raw = tokens[i];
    if (raw.startsWith('-')) continue;
    const unquoted = raw.replace(/^(['"])(.*)\1$/, '$2').trim();
    if (unquoted) files.push(unquoted);
  }
  return files;
}

/** 将相对路径基于远端 cwd 解析为 POSIX 绝对路径。 */
export function resolveRemotePath(baseDir: string, target: string): string {
  const raw = String(target || '').trim();
  if (!raw) return baseDir || '/';
  if (raw.startsWith('/')) return raw;
  const base = (baseDir || '/').replace(/\/+$/, '');
  return `${base}/${raw.replace(/^\.\//, '')}`;
}
