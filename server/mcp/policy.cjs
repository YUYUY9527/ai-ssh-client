const posixPath = require('node:path').posix;

const {
  LIMIT_BOUNDS,
  createDefaultPolicy,
  normalizePolicy,
} = require('./policy-file.cjs');

/**
 * 命令执行策略。
 *
 * 定位：**护栏，不是沙箱**。它拦住最常见、后果不可逆的破坏性命令，
 * 让 agent 的误操作在造成损失前停下来，但无法防住故意绕过
 * （base64 编码、脚本文件、别名、远端已有脚本等）。
 * 真正的隔离只能靠权限更低的 SSH 账号和主机侧限制，README 里已如实写明。
 *
 * 执行权限的来源（优先级从高到低）：
 * 1. 每个连接在 `data/mcp-policy.json` 里的显式模式；
 * 2. 显式设置的 `MCP_ALLOW_EXEC` 环境变量；
 * 3. 策略文件的 `defaultMode`；
 * 4. 默认只读。
 * 内置黑名单始终生效，`commands.exceptions` 只能精确放行整条命令。
 */

const DEFAULT_MAX_OUTPUT_BYTES = LIMIT_BOUNDS.maxOutputBytes.default;
const HARD_MAX_OUTPUT_BYTES = LIMIT_BOUNDS.maxOutputBytes.max;
const DEFAULT_EXEC_TIMEOUT_MS = LIMIT_BOUNDS.execTimeoutMs.default;
const HARD_MAX_EXEC_TIMEOUT_MS = LIMIT_BOUNDS.execTimeoutMs.max;
const DEFAULT_MAX_COMMAND_CHARS = LIMIT_BOUNDS.maxCommandChars.default;
const DEFAULT_MAX_READ_BYTES = LIMIT_BOUNDS.maxReadBytes.default;
const HARD_MAX_READ_BYTES = LIMIT_BOUNDS.maxReadBytes.max;

/** rm 递归删除时视为「不可接受」的目标（含常见等价写法）。 */
const CRITICAL_RM_TARGETS = new Set([
  '/', '/*', '~', '~/*', '$HOME', '$HOME/*', '${HOME}', '${HOME}/*',
  '*', '.', '..', './*',
  '/etc', '/etc/*', '/usr', '/usr/*', '/bin', '/bin/*', '/sbin', '/sbin/*',
  '/lib', '/lib/*', '/lib64', '/lib64/*', '/boot', '/boot/*',
  '/dev', '/dev/*', '/proc', '/proc/*', '/sys', '/sys/*',
  '/root', '/root/*', '/home', '/home/*', '/var', '/var/*',
  '/var/lib', '/var/lib/*',
  '~/.ssh', '~/.ssh/*', '/root/.ssh', '/root/.ssh/*',
  '~/.gnupg', '~/.gnupg/*', '~/.aws', '~/.aws/*',
]);

/** find -delete 时要额外拦截的顶层目录。 */
const CRITICAL_TOP_LEVEL = [
  '/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot',
  '/dev', '/proc', '/sys', '/root', '/home', '/var',
];

/** 整棵子树都不该被 agent 递归删除的路径（密钥、数据库、容器数据）。 */
const CRITICAL_SUBTREES = [
  '~/.ssh', '/root/.ssh', '~/.gnupg', '~/.aws',
  '/var/lib/mysql', '/var/lib/postgresql', '/var/lib/docker', '/var/lib/libvirt',
];

const DESTRUCTIVE_COMMAND_NAMES = new Set([
  'mkfs', 'wipefs', 'fdisk', 'sfdisk', 'cfdisk', 'parted', 'gdisk', 'sgdisk',
  'mkswap', 'cryptsetup', 'shutdown', 'reboot', 'halt', 'poweroff', 'kexec',
]);

/** 结构性高危模式（整条命令匹配）：管道喂给 shell、写关键文件、fork 炸弹等。 */
const DEFAULT_DENY_PATTERNS = [
  {
    id: 'pipe-to-shell',
    source: String.raw`\b(?:curl|wget)\b[^\n;]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:ba|z|k|da|fi)?sh\b`,
    reason: '禁止把 curl/wget 的输出直接管道给 shell 执行',
  },
  {
    id: 'pipe-to-interpreter',
    source: String.raw`\b(?:curl|wget)\b[^\n;]*\|\s*(?:sudo\s+)?(?:\S*\/)?(?:python[0-9.]*|perl|ruby|node)\b`,
    reason: '禁止把网络内容直接管道给解释器执行',
  },
  {
    id: 'fork-bomb',
    source: String.raw`:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}`,
    reason: '检测到 fork 炸弹写法',
  },
  {
    id: 'write-critical-file',
    source: String.raw`(?:>>?|\btee\b(?:\s+-a)?)\s*["']?(?:\/etc\/(?:passwd|shadow|sudoers|sudoers\.d\/[^\s"';|&]+)|\/boot\/[^\s"';|&]+)`,
    reason: '禁止直接覆盖 /etc/passwd、/etc/shadow、/etc/sudoers 或 /boot',
  },
  {
    id: 'write-block-device',
    source: String.raw`(?:>>?|\bdd\b[^\n;]*\bof=|\btee\b)\s*["']?\/dev\/(?:sd|nvme|hd|vd|mmcblk|xvd)`,
    reason: '禁止直接写入块设备',
  },
  {
    id: 'reverse-shell',
    source: String.raw`\/dev\/(?:tcp|udp)\/`,
    reason: '检测到 /dev/tcp 反向 shell 写法',
  },
];

const SHELL_SEGMENT_SEPARATOR = /\r?\n|&&|\|\||;|&/;
const SHELL_PREFIX_COMMANDS = new Set([
  'sudo', 'doas', 'env', 'nohup', 'time', 'command', 'builtin', 'exec', 'nice', 'ionice', 'stdbuf',
]);
const PREFIX_OPTIONS_WITH_VALUE = new Set(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-U', '-n']);

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function optionalInt(value, { envName, min, max }) {
  if (value === undefined || String(value).trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${envName}=${value} 无效，应为 ${min}..${max} 之间的整数`);
  }
  return parsed;
}

function envIsSet(env, name) {
  return env[name] !== undefined && String(env[name]).trim() !== '';
}

function compileRegex(source, label) {
  try {
    return new RegExp(source, 'i');
  } catch (error) {
    throw new Error(`${label} 不是合法正则：${error.message}`);
  }
}

function parsePatternList(value, envName) {
  if (value === undefined || String(value).trim() === '') {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${envName} 必须是 JSON 字符串数组：${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${envName} 必须是 JSON 字符串数组`);
  }
  return parsed.map((source, index) => {
    try {
      return new RegExp(source, 'i');
    } catch (error) {
      throw new Error(`${envName}[${index}] 不是合法正则：${error.message}`);
    }
  });
}

function parsePolicyEnv(env = process.env, filePolicy = null) {
  const file = normalizePolicy(filePolicy ?? undefined);

  const envDefaultMode = envIsSet(env, 'MCP_ALLOW_EXEC')
    ? (truthy(env.MCP_ALLOW_EXEC) ? 'exec' : 'read-only')
    : undefined;

  return {
    // 环境变量显式设置时覆盖文件的 defaultMode；连接级模式仍然优先。
    defaultMode: envDefaultMode || file.defaultMode,
    trustOnFirstUse: envIsSet(env, 'MCP_TRUST_ON_FIRST_USE')
      ? truthy(env.MCP_TRUST_ON_FIRST_USE)
      : file.trustOnFirstUse,
    maxOutputBytes: optionalInt(env.MCP_MAX_OUTPUT_BYTES, {
      envName: 'MCP_MAX_OUTPUT_BYTES',
      min: LIMIT_BOUNDS.maxOutputBytes.min,
      max: LIMIT_BOUNDS.maxOutputBytes.max,
    }) ?? file.limits.maxOutputBytes,
    execTimeoutMs: optionalInt(env.MCP_EXEC_TIMEOUT_MS, {
      envName: 'MCP_EXEC_TIMEOUT_MS',
      min: LIMIT_BOUNDS.execTimeoutMs.min,
      max: LIMIT_BOUNDS.execTimeoutMs.max,
    }) ?? file.limits.execTimeoutMs,
    maxCommandChars: optionalInt(env.MCP_MAX_COMMAND_CHARS, {
      envName: 'MCP_MAX_COMMAND_CHARS',
      min: LIMIT_BOUNDS.maxCommandChars.min,
      max: LIMIT_BOUNDS.maxCommandChars.max,
    }) ?? file.limits.maxCommandChars,
    maxReadBytes: optionalInt(env.MCP_MAX_READ_BYTES, {
      envName: 'MCP_MAX_READ_BYTES',
      min: LIMIT_BOUNDS.maxReadBytes.min,
      max: LIMIT_BOUNDS.maxReadBytes.max,
    }) ?? file.limits.maxReadBytes,
    auditEnabled: envIsSet(env, 'MCP_AUDIT')
      ? String(env.MCP_AUDIT).trim() !== '0'
      : file.audit.enabled,
    connections: { ...file.connections },
    exceptions: [...file.commands.exceptions],
    denyPatterns: [
      ...DEFAULT_DENY_PATTERNS,
      ...file.commands.deny.map((source, index) => ({
        id: `policy-deny-${index + 1}`,
        regex: compileRegex(source, `mcp-policy.json commands.deny[${index}]`),
        reason: '命中 mcp-policy.json 中的拒绝规则',
      })),
      ...parsePatternList(env.MCP_DENY_PATTERNS, 'MCP_DENY_PATTERNS').map((regex, index) => ({
        id: `custom-deny-${index + 1}`,
        regex,
        reason: '命中 MCP_DENY_PATTERNS 中的自定义规则',
      })),
    ],
    allowPatterns: parsePatternList(env.MCP_ALLOW_PATTERNS, 'MCP_ALLOW_PATTERNS'),
  };
}

/** 按 shell 语句分隔符切段；保留管道（`|`）以便识别 curl | sh。 */
function splitSegments(command) {
  return String(command)
    .split(SHELL_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 极简 shell 分词：处理单/双引号与反斜杠转义。
 * 目的只是让 `rm -rf "/"` 与 `rm -rf /` 得到同样的目标，不做完整 shell 解析。
 */
function tokenize(segment) {
  const tokens = [];
  let current = '';
  let quote = '';
  let started = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else if (char === '\\' && quote === '"' && index + 1 < segment.length) {
        current += segment[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === '\\' && index + 1 < segment.length) {
      current += segment[index + 1];
      index += 1;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) {
    tokens.push(current);
  }
  return tokens;
}

function baseName(token) {
  return String(token || '').split('/').pop() || '';
}

/** 去掉 sudo/env/nohup 等前缀及其选项，返回真正的命令 token 列表。 */
function stripPrefixes(inputTokens) {
  let tokens = inputTokens.slice();
  while (tokens.length > 0 && SHELL_PREFIX_COMMANDS.has(baseName(tokens[0]))) {
    tokens = tokens.slice(1);
    while (tokens.length > 0 && tokens[0].startsWith('-')) {
      const option = tokens.shift();
      if (PREFIX_OPTIONS_WITH_VALUE.has(option)) {
        tokens.shift();
      }
    }
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
  }
  return tokens;
}

function normalizeTarget(token) {
  const raw = String(token || '');
  if (raw === '~' || raw.startsWith('~/')) {
    return raw.replace(/\/+$/, '') || '~';
  }
  if (raw.startsWith('/')) {
    const normalized = posixPath.normalize(raw);
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  }
  return raw;
}

function isCriticalRmTarget(token) {
  const raw = String(token || '');
  if (CRITICAL_RM_TARGETS.has(raw)) {
    return true;
  }
  const normalized = normalizeTarget(raw);
  if (CRITICAL_RM_TARGETS.has(normalized) || CRITICAL_TOP_LEVEL.includes(normalized)) {
    return true;
  }
  return CRITICAL_SUBTREES.some(
    (subtree) => normalized === subtree || normalized.startsWith(`${subtree}/`),
  );
}

function flagSets(flags) {
  const recursive = flags.some(
    (flag) => flag === '--recursive' || (/^-[A-Za-z]+$/.test(flag) && /[rR]/.test(flag)),
  );
  const force = flags.some(
    (flag) => flag === '--force' || (/^-[A-Za-z]+$/.test(flag) && flag.includes('f')),
  );
  const noPreserveRoot = flags.includes('--no-preserve-root');
  return { recursive, force, noPreserveRoot };
}

function checkRm(args) {
  const flags = args.filter((arg) => arg.startsWith('-') && arg !== '-');
  const targets = args.filter((arg) => !arg.startsWith('-'));
  const { recursive, force, noPreserveRoot } = flagSets(flags);
  if (noPreserveRoot) {
    return { rule: 'rm-no-preserve-root', reason: '禁止 rm --no-preserve-root' };
  }
  if (recursive && targets.some(isCriticalRmTarget)) {
    return {
      rule: 'rm-critical-target',
      reason: `禁止递归删除关键路径（${targets.join(' ')}）；如确需清理，请由人手动执行`,
    };
  }
  if (force && recursive && targets.length === 0) {
    return { rule: 'rm-no-target', reason: '禁止无目标的 rm -rf' };
  }
  return null;
}

function checkFind(args) {
  if (!args.includes('-delete')) {
    return null;
  }
  const roots = args.filter((arg) => !arg.startsWith('-'));
  if (roots.some((root) => CRITICAL_TOP_LEVEL.includes(normalizeTarget(root)))) {
    return { rule: 'find-delete-critical', reason: '禁止对关键目录使用 find -delete' };
  }
  return null;
}

function checkSystemctl(args, commandName = 'systemctl') {
  // `service <unit> <action>` 的参数顺序与 systemctl 相反，单独取。
  const action = commandName === 'service'
    ? (args.find((arg) => !arg.startsWith('-')) ? args[1] : undefined)
    : args.find((arg) => !arg.startsWith('-'));
  if (!action) {
    return null;
  }
  if (/^(poweroff|reboot|halt|kexec|rescue|emergency)$/i.test(action)) {
    return { rule: 'systemctl-power', reason: `禁止通过 ${commandName} ${action} 关机/重启或进入救援模式` };
  }
  if (/^(stop|restart|disable|mask)$/i.test(action)) {
    const unit = commandName === 'service'
      ? (args[0] || '')
      : (args[args.indexOf(action) + 1] || '');
    if (/^(?:ssh|sshd|network|networking|firewalld|ufw)(?:\.service)?$/i.test(unit)) {
      return { rule: 'systemctl-network', reason: `禁止通过 ${commandName} ${action} ${unit} 切断 SSH 或防火墙` };
    }
  }
  return null;
}

/** 单段命令的语义检查；命中返回 { rule, reason }。 */
function checkSegment(segment, depth = 0) {
  const tokens = stripPrefixes(tokenize(segment));
  if (tokens.length === 0) {
    return null;
  }
  const name = baseName(tokens[0]);
  const args = tokens.slice(1);

  // 递归检查 `bash -c "..."` / `eval "..."` 里的真正命令：
  // 这是常见写法，不检查等于给破坏性命令留了后门。深度上限防自引用。
  if (depth < 3 && ['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(name)) {
    const flagIndex = args.findIndex(
      (arg) => arg === '-c' || /^-[a-z]*c[a-z]*$/.test(arg),
    );
    const nested = flagIndex >= 0 ? args[flagIndex + 1] : '';
    if (nested) {
      return checkSegment(nested, depth + 1);
    }
  }
  if (depth < 3 && name === 'eval' && args.length > 0) {
    return checkSegment(args.join(' '), depth + 1);
  }

  if (name === 'rm') {
    return checkRm(args);
  }
  if (name === 'find') {
    return checkFind(args);
  }
  if (name === 'dd' && args.some((arg) => /^of=\/dev\//i.test(arg))) {
    return { rule: 'dd-block-device', reason: '禁止 dd 直接写入块设备' };
  }
  if (name === 'shred' && args.some((arg) => /^\/dev\//.test(arg))) {
    return { rule: 'shred-device', reason: '禁止 shred 直接操作设备节点' };
  }
  if (DESTRUCTIVE_COMMAND_NAMES.has(name) || name.startsWith('mkfs.')) {
    return { rule: `${name}-blocked`, reason: `禁止执行 ${name}（格式化、分区或关机类命令）` };
  }
  if (name === 'init' && args.some((arg) => arg === '0' || arg === '6')) {
    return { rule: 'init-power', reason: '禁止切换运行级别到 0/6' };
  }
  if (name === 'systemctl' || name === 'service') {
    return checkSystemctl(args, name);
  }
  if (name === 'kill' || name === 'killall5') {
    if (name === 'killall5' || args.some((arg) => arg === '1' || arg === '-1')) {
      return { rule: 'kill-init', reason: '禁止 kill 1 / -1（会杀 init 或全部进程）' };
    }
  }
  if (name === 'chmod') {
    const { recursive } = flagSets(args.filter((arg) => arg.startsWith('-')));
    const targets = args.filter((arg) => !arg.startsWith('-'));
    if (recursive && targets.some(isCriticalRmTarget)) {
      return { rule: 'chmod-critical', reason: '禁止递归修改关键目录权限' };
    }
  }
  if (name === 'chown' || name === 'chgrp') {
    const { recursive } = flagSets(args.filter((arg) => arg.startsWith('-')));
    const targets = args.filter((arg) => !arg.startsWith('-'));
    if (recursive && targets.some((target) => isCriticalRmTarget(target) || target === '/')) {
      return { rule: 'chown-critical', reason: '禁止递归修改关键目录属主' };
    }
  }
  if (name === 'userdel' && args.includes('root')) {
    return { rule: 'userdel-root', reason: '禁止删除 root 用户' };
  }
  if (name === 'passwd' && args.includes('root')) {
    return { rule: 'passwd-root', reason: '禁止由 agent 修改 root 密码' };
  }
  if (name === 'ufw' && args.includes('disable')) {
    return { rule: 'ufw-disable', reason: '禁止关闭防火墙（ufw disable）' };
  }
  if (name === 'iptables' && args.includes('-F')) {
    return { rule: 'iptables-flush', reason: '禁止清空防火墙规则（iptables -F）' };
  }
  if (name === 'nft' && args.includes('flush')) {
    return { rule: 'nft-flush', reason: '禁止清空防火墙规则（nft flush）' };
  }
  return null;
}

function createPolicy(env = process.env, { filePolicy = null } = {}) {
  const config = parsePolicyEnv(env, filePolicy);
  const denyPatterns = config.denyPatterns.map((item) => (
    item.regex
      ? { ...item }
      : { ...item, regex: compileRegex(item.source, item.id) }
  ));
  const execAllowed = config.defaultMode === 'exec'
    || Object.values(config.connections).includes('exec');

  /** 连接在策略文件里的显式模式；没配置返回 null（跟随默认）。 */
  function explicitModeFor(connection) {
    if (!connection) {
      return null;
    }
    const byId = config.connections[String(connection.id ?? '')];
    if (byId) {
      return byId;
    }
    const name = String(connection.name || '').trim().toLowerCase();
    if (!name) {
      return null;
    }
    const key = Object.keys(config.connections).find((item) => item.toLowerCase() === name);
    return key ? config.connections[key] : null;
  }

  function modeFor(connection) {
    return explicitModeFor(connection) ?? config.defaultMode;
  }

  function execDisabledReason(connection) {
    const explicit = explicitModeFor(connection);
    if (connection && explicit === 'read-only') {
      return `连接 "${connection.name || connection.id}" 在 MCP 策略中被设为只读；`
        + '可在 Web 设置的 MCP 页面改为「可执行」。';
    }
    return '命令执行未开启。可在 Web 设置的 MCP 页面为连接开启执行，或设置 MCP_ALLOW_EXEC=1。';
  }

  function evaluateCommand(command, context = {}) {
    const connection = context?.connection || null;
    if (modeFor(connection) !== 'exec') {
      return {
        allowed: false,
        code: 'exec-disabled',
        reason: execDisabledReason(connection),
      };
    }

    const text = String(command ?? '');
    const trimmed = text.trim();
    if (!trimmed) {
      return { allowed: false, code: 'empty-command', reason: 'command 不能为空' };
    }
    if (text.length > config.maxCommandChars) {
      return {
        allowed: false,
        code: 'command-too-long',
        reason: `命令长度 ${text.length} 超过上限 ${config.maxCommandChars}`,
      };
    }

    // 精确例外：整条命令完全相等才放行，不支持正则或前缀匹配。
    // 这是「明知某条命令会被内置规则拦下、但在这台机器上确实需要」的唯一出口。
    if (config.exceptions.includes(trimmed)) {
      return {
        allowed: true,
        code: 'ok',
        rule: 'exception',
        reason: '命中 MCP 策略中的精确例外',
      };
    }

    // 结构性模式（管道喂 shell、写关键文件、fork 炸弹等）要按整条命令匹配：
    // 按 `;`/`&` 切段会破坏 fork 炸弹、管道这类跨段结构。
    for (const pattern of denyPatterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) {
        return { allowed: false, code: 'blocked', rule: pattern.id, reason: pattern.reason };
      }
    }

    for (const segment of splitSegments(text)) {
      const hit = checkSegment(segment);
      if (hit) {
        return { allowed: false, code: 'blocked', ...hit };
      }
    }

    if (config.allowPatterns.length > 0) {
      for (const segment of splitSegments(text)) {
        if (!config.allowPatterns.some((regex) => {
          regex.lastIndex = 0;
          return regex.test(segment);
        })) {
          return {
            allowed: false,
            code: 'not-allowlisted',
            reason: `命令片段不在白名单内：${segment}`,
          };
        }
      }
    }

    return { allowed: true, code: 'ok', reason: '' };
  }

  return {
    execAllowed,
    defaultMode: config.defaultMode,
    trustOnFirstUse: config.trustOnFirstUse,
    maxOutputBytes: config.maxOutputBytes,
    execTimeoutMs: config.execTimeoutMs,
    maxCommandChars: config.maxCommandChars,
    maxReadBytes: config.maxReadBytes,
    auditEnabled: config.auditEnabled,
    modeFor,
    evaluateCommand,
    /** 测试与文档用：把当前生效的规则暴露出来。 */
    describe() {
      return {
        execAllowed,
        defaultMode: config.defaultMode,
        connections: { ...config.connections },
        trustOnFirstUse: config.trustOnFirstUse,
        auditEnabled: config.auditEnabled,
        maxOutputBytes: config.maxOutputBytes,
        execTimeoutMs: config.execTimeoutMs,
        maxReadBytes: config.maxReadBytes,
        maxCommandChars: config.maxCommandChars,
        exceptionCount: config.exceptions.length,
        denyRules: denyPatterns.map((pattern) => pattern.id),
        allowPatterns: config.allowPatterns.map((regex) => String(regex)),
      };
    },
  };
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_READ_BYTES,
  HARD_MAX_EXEC_TIMEOUT_MS,
  DEFAULT_DENY_PATTERNS,
  parsePolicyEnv,
  createPolicy,
  evaluateCommand: (command, env) => createPolicy(env).evaluateCommand(command),
  // 供单测直接验证分词与语义规则
  tokenize,
  splitSegments,
  checkSegment,
};