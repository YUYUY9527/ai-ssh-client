/**
 * 命令风险分析器
 *
 * 该模块负责分析 Linux/Unix 命令的风险级别，用于在 AI Agent 执行前进行安全检查。
 *
 * 设计（2026-09 重写）：
 * - **按段解析**：先按 `&&` / `||` / `;` / `|` / 换行切分命令（引号与转义内的分隔符不算），
 *   再取每段「真正的命令名」—— 跳过 `VAR=value` 赋值、`sudo`/`env`/`nohup`/`timeout` 等
 *   前缀，并取 basename（`/bin/rm` → `rm`）。
 * - **首词 + 参数判定**：不再用整串 `includes(pattern)`。旧实现既漏（`rm -fr /`、
 *   `halt`、`dd of=/dev/sda` 都判 low），又误伤（`grep shutdown /var/log/syslog`
 *   被判 critical）。
 * - **纯函数、零依赖**：便于测试与复用；风险判定是 Agent 审批的最后一道逻辑闸门。
 *
 * 局限（有意为之）：
 * - 不做 shell 语义求值，变量拼接（`$CMD -rf /`）、动态生成（`$(...)`、`eval` 的间接层）
 *   仍无法完全解析；因此 `eval`、`| sh`、解释器 `-c` 等「二次执行」形态一律按高风险处理。
 * - 判定结果只用于「是否需要用户审批」，不是安全沙箱。
 */

import type { CommandSuggestion } from '../../shared/types';
import {
  ARG_SENSITIVE_COMMAND_HEADS,
  CRITICAL_COMMAND_HEADS,
  COMMAND_WRAPPER_HEADS,
  ELEVATION_COMMAND_HEADS,
  HIGH_RISK_COMMAND_HEADS,
  READ_ONLY_COMMAND_HEADS,
} from '../../shared/constants';

/**
 * 风险级别类型
 * - low: 低风险，普通操作命令
 * - medium: 中风险，会修改文件或系统状态
 * - high: 高风险，可能删除或修改重要数据
 * - critical: 严重风险，可能造成不可逆的系统损坏
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * 风险分析结果接口
 */
export interface RiskAnalysis {
  /** 分析的命令 */
  command: string;
  /** 风险级别 */
  riskLevel: RiskLevel;
  /** 是否为危险命令 */
  isDangerous: boolean;
  /** 风险描述 */
  description: string;
  /** 详细的风险说明（可选） */
  riskDescription?: string;
  /** 命中的危险模式（可选，保留兼容） */
  matchedPattern?: string;
  /** 命中的具体原因列表（用于 UI 展示「为什么」） */
  reasons?: string[];
  /** 是否只读命令（不修改远端状态） */
  readOnly?: boolean;
}

/**
 * 各风险级别的描述信息
 */
const RISK_DESCRIPTIONS: Record<RiskLevel, { description: string; riskDescription?: string }> = {
  critical: {
    description: '此命令可能会造成不可逆的系统损坏或数据丢失',
    riskDescription: '警告：此命令非常危险！可能导致系统崩溃或数据永久丢失。请确保你完全理解此命令的后果。',
  },
  high: {
    description: '此命令具有较高风险，可能删除或修改重要数据',
    riskDescription: '注意：此命令可能删除文件或修改系统配置。请确认这是你想要执行的操作。',
  },
  medium: {
    description: '此命令会修改文件或系统状态',
  },
  low: {
    description: '普通系统操作命令',
  },
};

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const CRITICAL_HEADS = new Set(CRITICAL_COMMAND_HEADS);
const HIGH_HEADS = new Set(HIGH_RISK_COMMAND_HEADS);
const ARG_SENSITIVE_HEADS = new Set(ARG_SENSITIVE_COMMAND_HEADS);
const READ_ONLY_HEADS = new Set(READ_ONLY_COMMAND_HEADS);
const ELEVATION_HEADS = new Set(ELEVATION_COMMAND_HEADS);
const WRAPPER_HEADS = new Set(COMMAND_WRAPPER_HEADS);

/** 不可逆目标：递归删除这些路径直接判 critical。 */
const FATAL_RM_TARGETS = [
  /^\/$/, /^\/\*+$/, /^\/\*\/?$/, /^\/etc\b/, /^\/boot\b/, /^\/usr\b/, /^\/var\b/,
  /^\/home\b/, /^\/root\b/, /^\/bin\b/, /^\/sbin\b/, /^\/lib\b/, /^~\/?$/, /^\$HOME\/?$/,
];

/** 重定向目标：写入这些路径意味着覆盖系统文件或块设备。 */
const SENSITIVE_REDIRECT_TARGETS = [
  { pattern: /^\/dev\/(sd|hd|vd|nvme|mmcblk|disk)/, level: 'critical' as RiskLevel, label: '重定向到块设备' },
  // /dev/null、/dev/stdout、/dev/fd/N 是丢弃/转发输出的常用写法，不能算风险；
  // 只有内核内存与 IO 端口才危险。
  { pattern: /^\/dev\/(mem|kmem|port)$/, level: 'critical' as RiskLevel, label: '重定向到内核内存/IO 端口' },
  { pattern: /^\/etc\//, level: 'high' as RiskLevel, label: '重定向到 /etc 系统配置' },
  { pattern: /^\/boot\//, level: 'high' as RiskLevel, label: '重定向到 /boot' },
];

/**
 * 写入即可持久化/破坏的系统路径。
 *
 * 这些路径不在 SENSITIVE_REDIRECT_TARGETS 里，但「写文件」同样是破坏性动作：
 * 覆盖 systemd 单元、写 ~/.ssh/authorized_keys 或 ~/.bashrc 都能落地持久化后门，
 * 因此任何写入型命令命中这里都应至少 high（而不是默认的「低风险免确认」）。
 */
const SYSTEM_WRITE_PATTERNS: RegExp[] = [
  /^\/(etc|boot|usr|bin|sbin|lib|lib64|root|proc|sys)(\/|$)/,
  /^\/var\/(spool|lib)(\/|$)/,
  /^\/dev\/(?!null$|stdout$|stderr$|fd\/|pts\/|tty)/,
  /^\/home\/[^/]+\/\.ssh(\/|$)/,
];

/** 登录/持久化文件（相对家目录或绝对路径均可命中）。 */
const PERSISTENCE_WRITE_PATTERN = /(^|\/)\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zlogin|kshrc|netrc|ssh\/authorized_keys|ssh\/authorized_keys2|ssh\/config|ssh\/rc)$/;

/** 临时目录：写在这里属于一次性产物，不额外提级。 */
const SCRATCH_WRITE_PATTERN = /^\/(tmp|var\/tmp|dev\/shm|run)(\/|$)/;

/** 丢弃/转发输出的目标：写入不改变远端状态。 */
const DISCARD_WRITE_PATTERN = /^\/dev\/(null|zero|stdout|stderr|tty|fd\/|pts\/|full)/;

/** 可静态判定的家目录写法；`$LOG` 之类变量目标无法判定，直接跳过。 */
const HOME_PATH_PREFIX = /^(~|\$HOME|\$\{HOME\})\//;

/** 是否是「文件路径」形态的重定向目标（排除 2>&1、>&2、裸数字、以及未知变量）。 */
function isPathLikeWriteTarget(target: string): boolean {
  const value = stripQuotes(target).trim();
  if (!value) return false;
  if (value.startsWith('&')) return false;
  if (/^\d+$/.test(value)) return false;
  if (value.startsWith('$') && !HOME_PATH_PREFIX.test(value) && !/^\$\{?TMPDIR\}?\//.test(value)) {
    return false;
  }
  return true;
}

function isScratchWriteTarget(target: string): boolean {
  const value = stripQuotes(target).trim();
  return SCRATCH_WRITE_PATTERN.test(value) || /^\$\{?TMPDIR\}?\//.test(value);
}

/** 写入是否只是丢弃输出（`>/dev/null 2>&1`、写 tty）。 */
function isDiscardWriteTarget(target: string): boolean {
  return DISCARD_WRITE_PATTERN.test(stripQuotes(target).trim());
}

/** 写入该目标是否会破坏系统文件或建立持久化（用于重定向与文件复制类命令）。 */
function isSensitiveWriteTarget(target: string): boolean {
  const value = stripQuotes(target).trim();
  if (!value) return false;
  if (HOME_PATH_PREFIX.test(value)) {
    const relative = value.replace(HOME_PATH_PREFIX, '');
    return PERSISTENCE_WRITE_PATTERN.test(relative);
  }
  return SYSTEM_WRITE_PATTERNS.some((pattern) => pattern.test(value))
    || PERSISTENCE_WRITE_PATTERN.test(value);
}

/** 取 `-m 4755` / `--mode=4755` 这类权限参数（用于识别 setuid/setgid 安装）。 */
function extractModeArg(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const value = stripQuotes(args[index]);
    const inline = value.match(/^--mode=(.+)$/);
    if (inline) return inline[1];
    if ((value === '-m' || value === '--mode') && args[index + 1] !== undefined) {
      return stripQuotes(args[index + 1]);
    }
  }
  return null;
}

/** 非选项操作数（源/目标路径）。 */
function operandsOf(args: string[]): string[] {
  return args.map(stripQuotes).filter((arg) => arg && !arg.startsWith('-'));
}

type Segment = {
  /** 该段原始文本 */
  raw: string;
  /** 分隔符：'pipe' 表示由 `|` 引入 */
  separator: 'start' | 'seq' | 'pipe';
};

/**
 * 按未加引号的命令分隔符切段。
 * 支持单/双引号与反斜杠转义；不解析 `$( )` 内部的嵌套（内部命令仍会被自身规则命中）。
 */
function splitCommandSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = '';
  let separator: Segment['separator'] = 'start';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const push = () => {
    const raw = current.trim();
    if (raw) {
      segments.push({ raw, separator });
    }
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }

    if (char === '\n') {
      push();
      separator = 'seq';
      continue;
    }
    if (char === ';') {
      push();
      separator = 'seq';
      continue;
    }
    if (char === '&' && command[index + 1] === '&') {
      push();
      separator = 'seq';
      index += 1;
      continue;
    }
    if (char === '|' && command[index + 1] === '|') {
      push();
      separator = 'seq';
      index += 1;
      continue;
    }
    if (char === '|') {
      push();
      separator = 'pipe';
      continue;
    }
    if (char === '&') {
      push();
      separator = 'seq';
      continue;
    }

    current += char;
  }

  push();
  return segments;
}

/** 去除一层匹配的引号。 */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return token.slice(1, -1);
    }
  }
  return token;
}

/** 按未加引号的空白切 token。 */
function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      current += char;
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** 取命令名：`/usr/bin/rm` → `rm`。 */
function commandBasename(token: string): string {
  const value = stripQuotes(token);
  const slash = value.lastIndexOf('/');
  return (slash >= 0 ? value.slice(slash + 1) : value).toLowerCase();
}

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

type ParsedSegment = {
  raw: string;
  separator: Segment['separator'];
  /** 解析出的命令名，可能为空（纯赋值段） */
  head: string | null;
  /** 命令名之后的原始 token */
  args: string[];
  /** 是否有提权前缀 */
  elevated: boolean;
};

/**
 * 解析一段命令：跳过赋值与前缀命令，返回真正的命令名与参数。
 */
function parseSegment(segment: Segment): ParsedSegment {
  const tokens = tokenizeSegment(segment.raw);
  let index = 0;
  let elevated = false;

  while (index < tokens.length) {
    const token = tokens[index];
    if (ASSIGNMENT_PATTERN.test(token)) {
      index += 1;
      continue;
    }
    const head = commandBasename(token);
    if (ELEVATION_HEADS.has(head)) {
      elevated = true;
      index += 1;
      // 跳过 `sudo -u user` / `sudo -E` 之类的自身参数
      while (index < tokens.length && tokens[index].startsWith('-')) index += 1;
      continue;
    }
    if (WRAPPER_HEADS.has(head)) {
      index += 1;
      // 跳过包装命令自身的数值/时长参数：timeout 30 / nice -n 10 / xargs -I {}
      while (index < tokens.length
        && (tokens[index].startsWith('-') || /^\d+[smhd]?$/.test(tokens[index]))) {
        index += 1;
      }
      continue;
    }
    return {
      raw: segment.raw,
      separator: segment.separator,
      head,
      args: tokens.slice(index + 1),
      elevated,
    };
  }

  return {
    raw: segment.raw,
    separator: segment.separator,
    head: null,
    args: [],
    elevated,
  };
}

const hasFlag = (args: string[], short: string, long?: string): boolean => args.some((arg) => {
  const value = stripQuotes(arg);
  if (value === `--${long}`) return true;
  if (!value.startsWith('-') || value.startsWith('--')) return false;
  // 组合短选项：-rf / -fr / -Rf
  return value.slice(1).includes(short);
});

type Hit = { level: RiskLevel; label: string };

/** 判定单段命令的风险。 */
function analyzeParsedSegment(parsed: ParsedSegment, depth: number): Hit[] {
  const hits: Hit[] = [];
  const head = parsed.head;
  if (!head) {
    return hits;
  }

  const args = parsed.args;
  const plainArgs = args.map(stripQuotes);

  // --- 首词直接定级 ---
  if (CRITICAL_HEADS.has(head)) {
    hits.push({ level: 'critical', label: `${head} 属于不可逆的系统级操作` });
  } else if (head.startsWith('mkfs')) {
    hits.push({ level: 'critical', label: 'mkfs 会格式化文件系统' });
  } else if (HIGH_HEADS.has(head)) {
    hits.push({ level: 'high', label: `${head} 会破坏或修改关键数据` });
  }

  // --- 二次执行：把字符串交给 shell / 解释器再执行 ---
  if (head === 'eval' && plainArgs.length > 0) {
    hits.push({ level: 'high', label: 'eval 会执行动态拼接的字符串' });
    if (depth < 2) {
      hits.push(...analyzeCommandString(plainArgs.join(' '), depth + 1));
    }
  }
  if (['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(head)) {
    const flagIndex = args.findIndex((arg) => /^-.*c$/.test(stripQuotes(arg)));
    if (flagIndex >= 0 && plainArgs[flagIndex + 1]) {
      if (depth < 2) {
        hits.push(...analyzeCommandString(plainArgs.slice(flagIndex + 1).join(' '), depth + 1));
      }
    } else if (parsed.separator === 'pipe') {
      hits.push({ level: 'high', label: '管道内容被直接交给 shell 执行' });
    }
  }
  if (['python', 'python3', 'perl', 'ruby', 'node', 'php', 'lua'].includes(head)) {
    const flagIndex = args.findIndex((arg) => /^-(c|e)$/.test(stripQuotes(arg)));
    if (flagIndex >= 0) {
      const payload = plainArgs.slice(flagIndex + 1).join(' ');
      hits.push({ level: 'high', label: '解释器执行内联代码' });
      if (payload && depth < 2) {
        hits.push(...analyzeCommandString(payload, depth + 1));
      }
    } else {
      hits.push({ level: 'medium', label: '解释器可执行任意操作' });
    }
  }

  // --- 重定向写入 ---
  // 写文件本身会改远端状态：系统路径/启动文件 high，普通路径 medium，临时目录不额外提级。
  for (const match of parsed.raw.matchAll(/(>>?)\s*("[^"]*"|'[^']*'|\S+)/g)) {
    const operator = match[1];
    const rawTarget = match[2];
    if (!isPathLikeWriteTarget(rawTarget)) {
      continue;
    }
    const target = stripQuotes(rawTarget).trim();
    const sensitive = SENSITIVE_REDIRECT_TARGETS.find((rule) => rule.pattern.test(target));
    if (sensitive) {
      hits.push({ level: sensitive.level, label: sensitive.label });
      continue;
    }
    if (isSensitiveWriteTarget(target)) {
      hits.push({
        level: 'high',
        label: operator === '>>' ? '追加写入系统/启动文件（可持久化）' : '覆盖系统/启动文件',
      });
      continue;
    }
    if (isScratchWriteTarget(target) || isDiscardWriteTarget(target)) {
      continue;
    }
    hits.push({
      level: 'medium',
      label: operator === '>>' ? '追加写入文件' : '重定向覆盖文件',
    });
  }

  // --- 首词相关参数分析 ---
  switch (head) {
    case 'rm': {
      const recursive = hasFlag(args, 'r') || hasFlag(args, 'R', 'recursive');
      const force = hasFlag(args, 'f', 'force');
      const targets = plainArgs.filter((arg) => !arg.startsWith('-'));
      const fatal = targets.some((target) => FATAL_RM_TARGETS.some((pattern) => pattern.test(target)));
      if (recursive && (fatal || force)) {
        hits.push({ level: 'critical', label: recursive && fatal ? '递归删除关键目录' : '递归强制删除' });
      } else if (recursive) {
        hits.push({ level: 'high', label: '递归删除目录' });
      } else if (fatal) {
        hits.push({ level: 'critical', label: '删除关键路径' });
      } else {
        hits.push({ level: 'medium', label: '删除文件' });
      }
      break;
    }
    case 'mv':
    case 'cp':
    case 'install': {
      const operands = operandsOf(args);
      const destination = operands[operands.length - 1] ?? '';
      const sources = operands.slice(0, -1);
      const mode = head === 'install' ? extractModeArg(args) : null;
      // setuid/setgid 安装 = 直接获得 root 权限的执行体
      if (mode !== null && /^[246][0-7]{3}$/.test(mode)) {
        hits.push({ level: 'critical', label: '安装 setuid/setgid 可执行文件（可提权）' });
        break;
      }
      // mv 会删掉源文件，源与目标都要看；cp/install 只写目标（读取系统文件不算危险）
      const touchesSystem = isSensitiveWriteTarget(destination)
        || (head === 'mv' && sources.some(isSensitiveWriteTarget));
      if (touchesSystem) {
        hits.push({ level: 'high', label: '覆盖或移动系统路径文件' });
        break;
      }
      if (head === 'mv') {
        hits.push({ level: 'medium', label: '移动/重命名文件（删除源文件）' });
      } else if (head === 'cp') {
        hits.push({ level: 'medium', label: '复制文件（可能覆盖目标）' });
      } else {
        hits.push({ level: 'medium', label: '安装文件到目标路径' });
      }
      break;
    }
    case 'ln': {
      const operands = operandsOf(args);
      const linkPath = operands[operands.length - 1] ?? '';
      hits.push(isSensitiveWriteTarget(linkPath)
        ? { level: 'high', label: '在系统路径创建符号链接（可用于持久化）' }
        : { level: 'medium', label: '创建符号链接' });
      break;
    }
    case 'useradd':
    case 'adduser':
    case 'usermod':
    case 'groupadd':
    case 'groupmod':
    case 'gpasswd':
    case 'chpasswd':
    case 'visudo':
    case 'userdel':
    case 'groupdel':
    case 'chsh': {
      const uidZero = /(^|\s)-u\s+0(\s|$)/.test(parsed.raw)
        || /(^|\s)--uid[=\s]+0(\s|$)/.test(parsed.raw);
      if (uidZero) {
        hits.push({ level: 'critical', label: '创建/修改 uid 为 0 的账号（等同 root）' });
      } else if (plainArgs.some((arg) => /^(sudo|wheel|admin|root)$/.test(arg))) {
        hits.push({ level: 'high', label: '授予管理员/免密提权权限' });
      } else {
        hits.push({ level: 'high', label: '修改系统账号或权限' });
      }
      break;
    }
    case 'chmod': {
      const recursive = hasFlag(args, 'R', 'recursive');
      const allPerms = plainArgs.some((arg) => /^0?7{3}$/.test(arg) || arg === '777');
      if (recursive && allPerms) {
        hits.push({ level: 'critical', label: '递归放开全部权限（777）' });
      } else if (recursive) {
        hits.push({ level: 'high', label: '递归修改权限' });
      } else if (allPerms) {
        hits.push({ level: 'high', label: '放开全部权限（777）' });
      } else {
        hits.push({ level: 'medium', label: '修改文件权限' });
      }
      break;
    }
    case 'chown':
    case 'chgrp': {
      const recursive = hasFlag(args, 'R', 'recursive');
      hits.push(recursive
        ? { level: 'high', label: '递归修改所有者/属组' }
        : { level: 'medium', label: '修改所有者/属组' });
      break;
    }
    case 'dd': {
      const deviceOutput = plainArgs.find((arg) => arg.startsWith('of=') && /of=\/dev\//.test(arg));
      hits.push(deviceOutput
        ? { level: 'critical', label: 'dd 直接写入块设备' }
        : { level: 'high', label: 'dd 可覆盖磁盘数据' });
      break;
    }
    case 'find': {
      const destroys = args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fls)$/.test(stripQuotes(arg)));
      if (destroys) {
        hits.push({ level: 'high', label: 'find 带删除/执行动作' });
      }
      break;
    }
    case 'truncate': {
      hits.push(plainArgs.includes('-s')
        ? { level: 'high', label: 'truncate 截断文件内容' }
        : { level: 'medium', label: 'truncate 修改文件大小' });
      break;
    }
    case 'sed': {
      if (hasFlag(args, 'i', 'in-place')) {
        hits.push({ level: 'medium', label: 'sed 原地改写文件' });
      }
      break;
    }
    case 'awk': {
      if (/[^>]>\s*\S|system\s*\(/.test(parsed.raw)) {
        hits.push({ level: 'medium', label: 'awk 脚本包含写入或外部调用' });
      }
      break;
    }
    case 'tee': {
      hits.push({ level: 'medium', label: 'tee 写入文件' });
      break;
    }
    case 'curl':
    case 'wget': {
      const writes = args.some((arg) => {
        const value = stripQuotes(arg);
        return /^(-d|--data|--data-\w+|-F|--form|-T|--upload-file|-O|--output|-o|--post-file)$/.test(value)
          || /^-X\s*(POST|PUT|PATCH|DELETE)$/i.test(value);
      });
      if (writes) {
        hits.push({ level: 'medium', label: '下载或上传会写入文件/改变远端状态' });
      }
      break;
    }
    case 'kill':
    case 'pkill':
    case 'killall': {
      const force = hasFlag(args, '9', 'signal');
      const everything = plainArgs.some((arg) => arg === '-1' || arg === '1');
      if (force && everything) {
        hits.push({ level: 'critical', label: '强制终止所有进程' });
      } else {
        hits.push({ level: 'medium', label: '终止进程' });
      }
      break;
    }
    case 'crontab': {
      if (args.some((arg) => stripQuotes(arg) === '-r')) {
        hits.push({ level: 'critical', label: 'crontab -r 清空全部定时任务' });
      } else if (args.some((arg) => stripQuotes(arg) === '-l')) {
        break;
      } else {
        hits.push({ level: 'medium', label: '修改定时任务' });
      }
      break;
    }
    case 'init': {
      const target = plainArgs.find((arg) => !arg.startsWith('-'));
      if (target && ['0', '1', '6', 's'].includes(target.toLowerCase())) {
        hits.push({ level: 'critical', label: 'init 切换运行级别会中断系统' });
      } else {
        hits.push({ level: 'medium', label: 'init 改变系统运行级别' });
      }
      break;
    }
    case 'iptables':
    case 'ip6tables':
    case 'nft': {
      const flush = args.some((arg) => /^-(F|X|P|Z)$/.test(stripQuotes(arg)))
        || plainArgs.includes('flush');
      const listing = args.some((arg) => /^(-L|S|C|nvL|vnL)$/.test(stripQuotes(arg)))
        || plainArgs.includes('list');
      if (flush) {
        hits.push({ level: 'high', label: '清空防火墙规则' });
      } else if (listing) {
        break;
      } else {
        hits.push({ level: 'medium', label: '修改防火墙规则' });
      }
      break;
    }
    case 'systemctl':
    case 'service': {
      const action = plainArgs.find((arg) => !arg.startsWith('-') && !arg.endsWith('.service'));
      const readOnlyActions = ['status', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'list-units', 'list-timers', 'list-sockets'];
      const highActions = ['stop', 'disable', 'mask', 'kill', 'isolate', 'emergency', 'rescue', 'halt', 'poweroff', 'reboot'];
      if (action && readOnlyActions.includes(action)) {
        break;
      }
      if (action && highActions.includes(action)) {
        hits.push({ level: 'high', label: `systemctl ${action} 会影响服务可用性` });
      } else {
        hits.push({ level: 'medium', label: '变更系统服务状态' });
      }
      break;
    }
    case 'apt':
    case 'apt-get':
    case 'yum':
    case 'dnf':
    case 'zypper':
    case 'pacman':
    case 'brew':
    case 'snap': {
      const action = plainArgs.find((arg) => !arg.startsWith('-'));
      const readOnlyActions = ['list', 'search', 'show', 'info', 'policy', 'check', 'version', '--version'];
      const highActions = ['remove', 'purge', 'erase', 'autoremove', 'dist-upgrade', 'uninstall'];
      if (action && readOnlyActions.includes(action)) {
        break;
      }
      if ((action && highActions.includes(action)) || /(-R|-Rs|-Rns)$/.test(plainArgs.join(' '))) {
        hits.push({ level: 'high', label: '卸载/升级软件包可能影响服务' });
      } else {
        hits.push({ level: 'medium', label: '安装或更新软件包' });
      }
      break;
    }
    case 'docker':
    case 'podman': {
      const sub = plainArgs.find((arg) => !arg.startsWith('-'));
      const readOnlySubs = ['ps', 'logs', 'inspect', 'stats', 'version', 'images', 'top', 'port', 'diff', 'events'];
      if (sub && readOnlySubs.includes(sub)) {
        break;
      }
      if (sub && ['rm', 'rmi', 'prune', 'kill'].includes(sub)) {
        hits.push({ level: 'high', label: `docker ${sub} 会删除容器/镜像或强制终止` });
      } else {
        hits.push({ level: 'medium', label: '变更容器状态' });
      }
      break;
    }
    case 'kubectl':
    case 'helm': {
      const sub = plainArgs.find((arg) => !arg.startsWith('-'));
      const readOnlySubs = ['get', 'describe', 'logs', 'top', 'explain', 'version', 'api-resources', 'list'];
      if (sub && readOnlySubs.includes(sub)) {
        break;
      }
      if (sub && ['delete', 'drain', 'uninstall', 'rollback'].includes(sub)) {
        hits.push({ level: 'high', label: `kubectl/helm ${sub} 会删除或中断工作负载` });
      } else {
        hits.push({ level: 'medium', label: '变更集群资源' });
      }
      break;
    }
    case 'git': {
      const joined = plainArgs.join(' ');
      const readOnlySubs = ['status', 'log', 'diff', 'show', 'branch', 'remote', 'config', 'rev-parse', 'ls-files', 'blame', 'describe'];
      const sub = plainArgs.find((arg) => !arg.startsWith('-'));
      const destructive = /push\s+.*(-f|--force)/.test(joined)
        || /reset\s+--hard/.test(joined)
        || /clean\s+.*-[a-z]*[fdx]/.test(joined)
        || /branch\s+.*-D/.test(joined)
        || /filter-branch/.test(joined);
      if (destructive) {
        hits.push({ level: 'high', label: 'git 破坏性操作（强推/硬重置/清理）' });
      } else if (sub && readOnlySubs.includes(sub)) {
        break;
      } else {
        hits.push({ level: 'medium', label: '修改仓库状态' });
      }
      break;
    }
    default:
      break;
  }

  // --- 通用危险形态 ---
  if (/:\(\)\s*\{|:\s*\|\s*:\s*&/.test(parsed.raw)) {
    hits.push({ level: 'critical', label: 'fork 炸弹' });
  }
  if (/\bbase64\b[^|]*\|\s*(ba|z|k)?sh\b/.test(parsed.raw)) {
    hits.push({ level: 'high', label: 'base64 解码后直接执行' });
  }
  if (/\b(curl|wget)\b[^|]*\|\s*(ba|z|k)?sh\b/.test(parsed.raw)) {
    hits.push({ level: 'high', label: '下载内容直接交给 shell 执行' });
  }
  if (/\bmv\s+\/\*/.test(parsed.raw)) {
    hits.push({ level: 'critical', label: '移动根目录全部内容' });
  }

  // --- 提权至少 medium ---
  if (parsed.elevated) {
    hits.push({ level: 'medium', label: '以提权方式执行' });
  }

  return hits;
}

/** 递归入口：分析一段命令字符串。 */
function analyzeCommandString(command: string, depth = 0): Hit[] {
  const hits: Hit[] = [];
  for (const segment of splitCommandSegments(command)) {
    hits.push(...analyzeParsedSegment(parseSegment(segment), depth));
  }
  return hits;
}

/** 是否只读：所有段都是只读命令且无提权、无重定向写入。 */
function isReadOnlyCommand(parsedSegments: ParsedSegment[]): boolean {
  if (parsedSegments.length === 0) {
    return false;
  }

  return parsedSegments.every((parsed) => {
    if (!parsed.head || parsed.elevated) {
      return false;
    }
    if (/(?:^|[^>])>>?\s*\S/.test(parsed.raw)) {
      return false;
    }
    if (parsed.head === 'sed') {
      return !hasFlag(parsed.args, 'i', 'in-place');
    }
    if (parsed.head === 'find') {
      return !parsed.args.some((arg) => /^-(delete|exec|execdir|ok|okdir|fprint|fls)$/.test(stripQuotes(arg)));
    }
    if (parsed.head === 'systemctl' || parsed.head === 'service') {
      const action = parsed.args.map(stripQuotes).find((arg) => !arg.startsWith('-')) ?? '';
      return ['status', 'is-active', 'is-enabled', 'is-failed', 'show', 'cat', 'list-units'].includes(action);
    }
    if (parsed.head === 'ip') {
      return parsed.args.length === 0
        || parsed.args.map(stripQuotes).every((arg) => /^(addr|a|route|r|link|l|neigh|n|show|s|get)$/.test(arg) || arg.startsWith('-'));
    }
    return READ_ONLY_HEADS.has(parsed.head);
  });
}

const highest = (hits: Hit[]): Hit | null => hits.reduce<Hit | null>((acc, hit) => (
  !acc || RISK_ORDER[hit.level] > RISK_ORDER[acc.level] ? hit : acc
), null);

/**
 * 通过解析与规则匹配分析命令风险。
 *
 * @param command - 要分析的命令
 * @returns 风险级别、命中原因与只读标记
 */
export function analyzeCommandRisk(command: string): RiskAnalysis {
  const trimmedCmd = command.trim();
  const segments = splitCommandSegments(trimmedCmd);
  const parsedSegments = segments.map(parseSegment);
  const hits = analyzeCommandString(trimmedCmd);
  const top = highest(hits);

  const riskLevel: RiskLevel = top ? top.level : 'low';
  const reasons = [...new Set(hits.map((hit) => hit.label))];

  return {
    command: trimmedCmd,
    riskLevel,
    isDangerous: riskLevel !== 'low',
    description: RISK_DESCRIPTIONS[riskLevel].description,
    riskDescription: buildRiskDescription(riskLevel, reasons),
    matchedPattern: top?.label,
    reasons,
    readOnly: riskLevel === 'low' && isReadOnlyCommand(parsedSegments),
  };
}

function buildRiskDescription(riskLevel: RiskLevel, reasons: string[]): string | undefined {
  const base = RISK_DESCRIPTIONS[riskLevel].riskDescription;
  const detail = reasons.length > 0 ? `命中规则：${reasons.join('；')}` : '';
  const combined = [base, detail].filter(Boolean).join('\n');
  return combined || undefined;
}

/**
 * 将风险分析结果转换为命令建议格式
 *
 * 用于 UI 显示和用户确认
 *
 * @param command - 要分析的命令
 * @returns 命令建议对象
 */
export function riskAnalysisToSuggestion(command: string): CommandSuggestion {
  const analysis = analyzeCommandRisk(command);
  return {
    command: analysis.command,
    description: analysis.description,
    isDangerous: analysis.isDangerous,
    riskLevel: analysis.riskLevel,
    riskDescription: analysis.riskDescription,
    readOnly: analysis.readOnly,
  };
}

/**
 * 批量分析多个命令的风险
 *
 * @param commands - 命令字符串数组
 * @returns 风险分析结果数组
 */
export function analyzeCommandsRisk(commands: string[]): RiskAnalysis[] {
  return commands.map((cmd) => analyzeCommandRisk(cmd));
}

/**
 * 判断命令是否需要用户审批
 *
 * 当命令风险级别达到或超过阈值时，需要用户确认后才能执行
 *
 * @param command - 要检查的命令
 * @param threshold - 风险级别阈值（默认为 medium）
 * @returns 如果需要审批返回 true
 */
export function requiresApproval(command: string, threshold: RiskLevel = 'medium'): boolean {
  return getRiskWeight(analyzeCommandRisk(command).riskLevel) >= getRiskWeight(threshold);
}

/**
 * 获取风险级别的权重值
 *
 * 用于风险级别的比较和排序
 *
 * @param level - 风险级别
 * @returns 风险权重（0-3）
 */
export function getRiskWeight(level: RiskLevel): number {
  return RISK_ORDER[level];
}

/**
 * 比较两个风险级别
 *
 * @param a - 第一个风险级别
 * @param b - 第二个风险级别
 * @returns 负数表示 a < b，0 表示相等，正数表示 a > b
 */
export function compareRiskLevels(a: RiskLevel, b: RiskLevel): number {
  return Math.sign(getRiskWeight(a) - getRiskWeight(b));
}
