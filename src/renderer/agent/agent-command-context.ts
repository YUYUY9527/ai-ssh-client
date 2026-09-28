/**
 * Agent 执行上下文（纯函数，无依赖）
 *
 * 解决两个具体问题：
 * 1. **模型不知道自己在哪台机器上**：主决策消息里只有「用户任务」和命令输出，
 *    没有主机、用户、当前目录，模型只能靠 `whoami`/`pwd` 反复试探。
 * 2. **`cd` 不会跨步骤生效**：单行命令被哨兵包装成 `( cmd )` 子 shell（`sentinel.rs`
 *    / `sentinel.cjs`），模型发一条单独的 `cd /var/log` 后，下一步 `cat nginx.log`
 *    仍在原目录执行，任务就此卡死。
 *
 * 这里提供三件事：
 * - `resolveSessionConnectionInfo` 之外的 `buildAgentEnvironmentContext`：把会话环境
 *   渲染成一段系统提示；
 * - `extractAgentCwdFromCommand`：从模型命令里解析绝对路径 `cd`，跟踪 Agent 自己的
 *   工作目录；
 * - `prefixAgentCwd`：给单行命令加上 `cd '<cwd>' && ` 前缀，让相对路径落在预期目录。
 *
 * 只处理**绝对路径**的 `cd`：`cd ~` / `cd $VAR` / `cd -` 依赖远端 shell 展开，本地无法
 * 可靠推断，宁可不动（保持原行为）也不要猜错目录。
 *
 * 故意**不**给多行/heredoc 命令加前缀：多行命令走裸执行（不在子 shell 里），加前缀会
 * 真实改变用户交互会话的 cwd；这类命令由提示词要求模型自己写 `cd X && ...`。
 */

export interface AgentSessionEnvironment {
  /** 连接（或会话）名称 */
  connectionName?: string;
  /** 主机地址 */
  host?: string;
  /** 登录用户名 */
  username?: string;
  /** 端口 */
  port?: number;
  /** 远端会话当前工作目录（来自 shell integration / OSC 7） */
  cwd?: string;
}

/** 远端绝对路径：本地只接受可以安全单引号包裹的绝对路径。 */
const ABSOLUTE_CWD_PATTERN = /^\/[^\0\n]*$/;

/** 无法在本地安全展开的字符：变量、命令替换、通配符、shell 连接符。 */
const UNRESOLVABLE_CWD_PATTERN = /[$`*?&|;<>\\]/;

/**
 * 规范化 `cd` 目标路径：仅接受绝对路径。
 * 返回 null 表示「无法可靠跟踪」，调用方应保持原状。
 */
export function normalizeAgentCwdPath(rawPath: string): string | null {
  const path = rawPath.trim().replace(/\/+$/, '') || '/';
  if (!ABSOLUTE_CWD_PATTERN.test(path)) return null;
  if (UNRESOLVABLE_CWD_PATTERN.test(path)) return null;
  return path;
}

/**
 * 从命令开头解析 `cd <绝对路径>`，返回跟踪到的新工作目录。
 *
 * 只解析首段：`cd /var/log && ls` 与 `cd /var/log` 都返回 `/var/log`；
 * `ls && cd /var/log`、`cd /var/log`（在第二行）不跟踪。
 */
export function extractAgentCwdFromCommand(command: string): string | null {
  const firstSegment = command.split(/\n|;|&&|\|\|/)[0]?.trim() ?? '';
  const match = /^cd\s+(?:--\s+)?(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(firstSegment);
  if (!match) return null;

  const rawPath = match[1] ?? match[2] ?? match[3] ?? '';
  return normalizeAgentCwdPath(rawPath);
}

/** 该命令是否适合加 `cd` 前缀（仅单行、非 `cd` 自身、非 heredoc）。 */
export function shouldPrefixAgentCwd(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (trimmed.includes('\n') || trimmed.includes('<<')) return false;
  if (/^cd(?:\s|$)/.test(trimmed)) return false;
  return true;
}

/** 用单引号包裹路径，内部的单引号按 POSIX 规则转义。 */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 给命令加上 `cd '<cwd>' && ` 前缀；cwd 为空时原样返回。 */
export function prefixAgentCwd(command: string, cwd: string | null | undefined): string {
  if (!cwd) return command;
  if (!shouldPrefixAgentCwd(command)) return command;
  // 不用 `cd --`：那是 bash/zsh/dash 的扩展，fish/csh 不认。跟踪到的路径一定是绝对路径
  // （以 / 开头），单引号包裹后不存在被当成选项解析的风险。
  return `cd ${shellSingleQuote(cwd)} && ${command}`;
}

/**
 * 渲染「当前 SSH 会话环境」提示。
 * 环境与 cwd 都未知时返回 null（调用方不要注入空提示）。
 */
export function buildAgentEnvironmentContext(
  environment: AgentSessionEnvironment | null,
  cwd: string | null,
): string | null {
  const lines: string[] = [];
  const hasIdentity = Boolean(environment?.host || environment?.username || environment?.connectionName);

  if (hasIdentity) {
    const target = [environment?.username, environment?.host].filter(Boolean).join('@');
    const port = environment?.port && environment.port !== 22 ? `:${environment.port}` : '';
    const name = environment?.connectionName ? `（连接名：${environment.connectionName}）` : '';
    lines.push(`- 主机：${target}${port}${name}`);
  }

  if (cwd) {
    lines.push(`- Agent 当前工作目录：${cwd}`);
  }

  if (lines.length === 0) {
    return null;
  }

  lines.push('- 单行命令会自动在 `cd <当前目录> && ` 之后执行；`cd` 不会跨步骤保持，'
    + '需要切换目录时请写成 `cd <目录> && <命令>` 或直接使用绝对路径。');

  return ['当前 SSH 会话环境：', ...lines].join('\n');
}
