/**
 * 命令提取器 - 从 AI 响应中提取可执行命令
 */

const SUSPICIOUS_PATTERNS = [
  /\$\([^\n]*\)/,                    // 命令替换 $()
  /`[^\n]*`/,                        // 反引号命令替换
  /\|\s*(sh|bash)\b/i,              // 管道到 shell
  /;\s*(rm|mkfs|dd|shutdown|reboot)\b/i,  // 分号接危险命令
  />\s*\/dev\/(sda|hda|nvme|vd)/i,  // 重定向到块设备（只拦截危险设备）
];

// 合法 shell 语法白名单：这些不应被误判为可疑
const LEGAL_SHELL_SYNTAX = [
  /2>&1/,                            // 标准错误重定向到标准输出
  /2>\/dev\/null/,                   // 丢弃标准错误
  />\/dev\/null/,                    // 丢弃标准输出
  /\|\s*(grep|awk|sed|cut|sort|uniq|wc|xargs|head|tail|tee|tr|column|jq|yq)\b/i,  // 管道到文本处理
];

const VALID_COMMAND_PREFIXES = [
  'sudo', 'docker', 'kubectl', 'git', 'npm', 'yarn', 'pm2', 'systemctl', 'service',
  'chmod', 'chown', 'apt', 'yum', 'dnf', 'brew', 'pip', 'conda', 'node', 'cargo',
  'ls', 'cd', 'cat', 'grep', 'awk', 'sed', 'pwd', 'whoami', 'uname', 'top', 'ps',
  'df', 'du', 'tail', 'head', 'less', 'more', 'find', 'xargs', 'sort', 'uniq',
  'wc', 'cut', 'tr', 'mkdir', 'rmdir', 'touch', 'echo', 'printf', 'export',
  'source', 'alias', 'unalias', 'history', 'man', 'which', 'whereis', 'locate',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'bzip2', 'bunzip2', 'kill', 'killall', 'pgrep', 'pkill', 'jobs', 'bg', 'fg', 'nohup',
];

const COMMAND_PREFIX_REGEX = new RegExp(`^(${VALID_COMMAND_PREFIXES.join('|')})\\b`, 'i');

function normalizeCandidate(command: string): string {
  return command
    .trim()
    .replace(/^[-*]\s*/, '')
    .replace(/^`|`$/g, '')
    .replace(/^\$\s*/, '')
    .trim();
}

export function hasSuspiciousPattern(command: string): boolean {
  const normalized = normalizeCandidate(command);

  // 先检查是否匹配合法 shell 语法白名单
  if (LEGAL_SHELL_SYNTAX.some((pattern) => pattern.test(normalized))) {
    // 仍需检查是否有真正的危险模式（命令替换、管道到shell等）
    const trulyDangerous = [
      /\$\([^\n]*\)/,
      /`[^\n]*`/,
      /\|\s*(sh|bash)\b/i,
      /;\s*(rm|mkfs|dd|shutdown|reboot)\b/i,
      />\s*\/dev\/(sda|hda|nvme|vd)/i,
    ];
    return trulyDangerous.some((pattern) => pattern.test(normalized));
  }

  return SUSPICIOUS_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isValidCommandPrefix(command: string): boolean {
  return COMMAND_PREFIX_REGEX.test(normalizeCandidate(command));
}

function filterValidLines(lines: string[]): string[] {
  return lines
    .map(normalizeCandidate)
    .filter((line) => line && !line.startsWith('#') && !hasSuspiciousPattern(line));
}

function extractFromBashBlock(response: string): string | null {
  const match = response.match(/```(?:bash|sh|shell)\n([\s\S]*?)\n```/i);
  if (!match?.[1]) return null;
  return filterValidLines(match[1].split('\n'))[0] || null;
}

function extractFromCodeBlock(response: string): string | null {
  const match = response.match(/```\n([\s\S]*?)\n```/);
  if (!match?.[1]) return null;
  return filterValidLines(match[1].split('\n'))[0] || null;
}

function extractFromSingleLineBash(response: string): string | null {
  const match = response.match(/```(?:bash|sh|shell)\s+([^\n]+)\s*```/i);
  const cmd = match?.[1] ? normalizeCandidate(match[1]) : '';
  return cmd && !hasSuspiciousPattern(cmd) ? cmd : null;
}

function extractFromInlineCode(response: string): string | null {
  const match = response.match(/`([^`\n]+)`/);
  const cmd = match?.[1] ? normalizeCandidate(match[1]) : '';
  if (!cmd || hasSuspiciousPattern(cmd)) return null;
  return isValidCommandPrefix(cmd) || cmd.includes(' ') ? cmd : null;
}

function extractFromPrompt(response: string): string | null {
  const match = response.match(/^\s*[$>]\s*(.+)$/m);
  const cmd = match?.[1] ? normalizeCandidate(match[1]) : '';
  return cmd && !hasSuspiciousPattern(cmd) ? cmd : null;
}

function extractListCommandCandidate(line: string): string | null {
  const normalized = normalizeCandidate(line);
  const listMatch = normalized.match(/^([a-zA-Z][^：:]*?)(?:\s*[：:]\s*.+)?$/);
  if (!listMatch?.[1]) return null;

  const commandPart = listMatch[1].trim();
  if (!isValidCommandPrefix(commandPart) || hasSuspiciousPattern(commandPart)) {
    return null;
  }
  return commandPart;
}

function extractFromListFormat(response: string): string | null {
  const lines = response.split('\n');
  for (const line of lines) {
    if (!/^\s*[-*]/.test(line)) continue;
    const command = extractListCommandCandidate(line);
    if (command) return command;
  }
  return null;
}

function extractFromSingleLine(response: string): string | null {
  const singleLine = normalizeCandidate(response.split('\n')[0] || '');
  if (!singleLine || hasSuspiciousPattern(singleLine)) return null;

  const hasCommandIndicator = [
    COMMAND_PREFIX_REGEX,
    /^[a-zA-Z][a-zA-Z0-9_\-/.]+\s+/,
    /\|\s*(grep|awk|sed|cut|sort|uniq|wc|xargs|head|tail|tee|tr|column|jq|yq)/i,
  ].some((regex) => regex.test(singleLine));

  const isSentence = /^[\u4e00-\u9fa5\u3040-\u30ff]/.test(singleLine);
  return hasCommandIndicator && !isSentence ? singleLine : null;
}

export function extractCommand(aiResponse: string): string | null {
  const cleaned = aiResponse.trim();
  const extractors = [
    extractFromBashBlock,
    extractFromCodeBlock,
    extractFromSingleLineBash,
    extractFromInlineCode,
    extractFromPrompt,
    extractFromListFormat,
    extractFromSingleLine,
  ];

  for (const extractor of extractors) {
    const result = extractor(cleaned);
    if (result) return result;
  }

  return null;
}

export function extractAllCommands(aiResponse: string): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();

  for (const line of aiResponse.split('\n')) {
    if (!/^\s*[-*]/.test(line)) continue;
    const command = extractListCommandCandidate(line);
    if (command && !seen.has(command)) {
      seen.add(command);
      commands.push(command);
    }
  }

  return commands;
}
