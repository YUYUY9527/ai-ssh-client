/**
 * 命令提取器 - 从 AI 响应中提取可执行命令
 *
 * 该模块负责从 AI 的自然语言响应中识别和提取 Linux/Unix 命令。
 * 支持多种格式：代码块、行内代码、列表格式等。
 * 同时会进行安全检查，过滤掉可疑的危险命令。
 */

/**
 * 可疑命令模式列表
 *
 * 这些模式用于识别可能包含恶意代码的命令
 */
const SUSPICIOUS_PATTERNS = [
  /\$\([^\n]*\)/,                    // 命令替换 $()
  /`[^\n]*`/,                        // 反引号命令替换
  /\|\s*(sh|bash)\b/i,              // 管道到 shell
  /;\s*(rm|mkfs|dd|shutdown|reboot)\b/i,  // 分号接危险命令
  />\s*\/dev\/(sda|hda|nvme|vd)/i,  // 重定向到块设备（只拦截危险设备）
];

/**
 * 合法 Shell 语法白名单
 *
 * 这些模式是常见的合法 Shell 语法，不应被误判为可疑
 */
const LEGAL_SHELL_SYNTAX = [
  /2>&1/,                            // 标准错误重定向到标准输出
  /2>\/dev\/null/,                   // 丢弃标准错误
  />\/dev\/null/,                    // 丢弃标准输出
  /\|\s*(grep|awk|sed|cut|sort|uniq|wc|xargs|head|tail|tee|tr|column|jq|yq)\b/i,  // 管道到文本处理
];

/**
 * 有效命令前缀列表
 *
 * 用于验证提取的命令是否以合法的命令开头
 */
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

/**
 * 规范化命令候选字符串
 *
 * 移除列表标记、代码块标记、提示符等额外字符
 *
 * @param command - 原始命令字符串
 * @returns 清理后的命令字符串
 */
function normalizeCandidate(command: string): string {
  return command
    .trim()
    .replace(/^[-*]\s*/, '')      // 移除列表标记
    .replace(/^`|`$/g, '')         // 移除反引号
    .replace(/^\$\s*/, '')         // 移除 $ 提示符
    .trim();
}

/**
 * 检查命令是否包含可疑模式
 *
 * @param command - 要检查的命令
 * @returns 如果包含可疑模式返回 true
 */
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

/**
 * 检查命令是否以有效的命令前缀开头
 *
 * @param command - 要检查的命令
 * @returns 如果以有效前缀开头返回 true
 */
export function isValidCommandPrefix(command: string): boolean {
  return COMMAND_PREFIX_REGEX.test(normalizeCandidate(command));
}

/**
 * 过滤有效的命令行
 *
 * 移除注释行和包含可疑模式的行
 *
 * @param lines - 命令行数组
 * @returns 过滤后的有效命令行数组
 */
function filterValidLines(lines: string[]): string[] {
  return lines
    .map(normalizeCandidate)
    .filter((line) => line && !line.startsWith('#') && !hasSuspiciousPattern(line));
}

/**
 * 从 Bash 代码块中提取命令
 *
 * 匹配 ```bash、```sh、```shell 代码块
 *
 * @param response - AI 响应文本
 * @returns 提取的命令，如果未找到返回 null
 */
function extractFromBashBlock(response: string): string | null {
  const match = response.match(/```(?:bash|sh|shell)\n([\s\S]*?)\n```/i);
  if (!match?.[1]) return null;
  return filterValidLines(match[1].split('\n'))[0] || null;
}

/**
 * 从通用代码块中提取命令
 *
 * 匹配不带语言标识的代码块 ```
 *
 * @param response - AI 响应文本
 * @returns 提取的命令，如果未找到返回 null
 */
function extractFromCodeBlock(response: string): string | null {
  const match = response.match(/```\n([\s\S]*?)\n```/);
  if (!match?.[1]) return null;
  return filterValidLines(match[1].split('\n'))[0] || null;
}

/**
 * 从单行 Bash 代码中提取命令
 *
 * 匹配 ```bash command``` 格式
 *
 * @param response - AI 响应文本
 * @returns 提取的命令，如果未找到返回 null
 */
function extractFromSingleLineBash(response: string): string | null {
  const match = response.match(/```(?:bash|sh|shell)\s+([^\n]+)\s*```/i);
  const cmd = match?.[1] ? normalizeCandidate(match[1]) : '';
  return cmd && !hasSuspiciousPattern(cmd) ? cmd : null;
}

/**
 * 从行内代码中提取命令
 *
 * 匹配 `command` 格式
 *
 * @param response - AI 响应文本
 * @returns 提取的命令，如果未找到返回 null
 */
function extractFromInlineCode(response: string): string | null {
  const match = response.match(/`([^`\n]+)`/);
  const cmd = match?.[1] ? normalizeCandidate(match[1]) : '';
  if (!cmd || hasSuspiciousPattern(cmd)) return null;
  return isValidCommandPrefix(cmd) || cmd.includes(' ') ? cmd : null;
}

/**
 * 从 Shell 提示符格式中提取命令
 *
 * 匹配 $ command 或 > command 格式
 *
 * @param response - AI 响应文本
 * @returns 提取的命令，如果未找到返回 null
 */
function extractFromPrompt(response: string): string | null {
  const match = response.match(/^\s*[$>]\s*(.+)$/m);
  const cmd = match?.[1] ? normalizeCandidate(match[1]) : '';
  return cmd && !hasSuspiciousPattern(cmd) ? cmd : null;
}

/**
 * 从列表项中提取命令候选
 *
 * 处理 "- command: description" 格式
 *
 * @param line - 列表项行
 * @returns 提取的命令，如果无效返回 null
 */
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

/**
 * 从列表格式中提取命令
 *
 * 处理以 - 或 * 开头的列表格式
 *
 * @param response - AI 响应文本
 * @returns 提取的第一个有效命令，如果未找到返回 null
 */
function extractFromListFormat(response: string): string | null {
  const lines = response.split('\n');
  for (const line of lines) {
    if (!/^\s*[-*]/.test(line)) continue;
    const command = extractListCommandCandidate(line);
    if (command) return command;
  }
  return null;
}

/**
 * 从单行文本中提取命令
 *
 * 作为最后的尝试，直接提取第一行作为命令
 *
 * @param response - AI 响应文本
 * @returns 提取的命令，如果不像命令返回 null
 */
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

/**
 * 从 AI 响应中提取命令的主函数
 *
 * 尝试多种提取策略，按优先级依次尝试：
 * 1. Bash 代码块
 * 2. 通用代码块
 * 3. 单行 Bash 代码
 * 4. 行内代码
 * 5. Shell 提示符格式
 * 6. 列表格式
 * 7. 单行文本
 *
 * @param aiResponse - AI 的响应文本
 * @returns 提取的命令字符串，如果未找到返回 null
 */
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

/**
 * 从 AI 响应中提取所有命令
 *
 * 与 extractCommand 不同，这个函数会提取所有找到的命令
 *
 * @param aiResponse - AI 的响应文本
 * @returns 提取的命令数组
 */
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
