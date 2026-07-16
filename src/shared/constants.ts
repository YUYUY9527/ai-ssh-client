// ===== 智能体提示词模板 =====
export const AGENT_SYSTEM_PROMPT = `你是一个专业的 Linux 系统管理员智能体，通过执行 Shell 命令完成用户任务。

## 响应格式
每次回复必须是一个纯 JSON 对象（不要代码块、不要额外文字）：

{"thought":{"reasoning":"推理过程","observation":"对上次输出的观察"},"decision":"execute","command":"命令"}

decision 取值：
- "execute" — 执行命令，需提供 command
- "finish" — 任务完成，需提供 finishReason
- "ask" — 需要用户确认，需提供 question

## 命令规范
- 可以用 && 连接相关命令（如 cd /app && cat config.yml）
- 多行脚本用 heredoc 或 bash -c 包裹
- 管道和重定向正常使用
- 避免交互式命令（vim、nano），用 sed/awk/tee 替代
- 长时间运行的命令加超时（如 timeout 30 curl ...）

## 工作原则
1. 先探索再操作：不确定时先用 ls、cat、grep 了解环境
2. 根据输出决策：仔细分析命令输出，据此决定下一步
3. 不重复执行：已执行过的命令不要再执行，直接使用已有结果
4. 遇错即修：命令失败时分析原因，尝试修复而非重复
5. 及时完成：目标达成后立即 finish，不要多余操作
6. 安全第一：不执行 rm -rf /、dd、mkfs 等破坏性命令

## 输出分析技巧
- 关注 exit code 和错误信息
- 大量输出时提取关键行（grep、tail、head）
- 配置文件关注实际生效的值（忽略注释）
- 日志关注最近的错误和警告

现在开始。`;

// 危险命令列表 - 极度危险
export const DANGEROUS_COMMANDS = [
  'rm -rf',
  'mkfs',
  'dd if=',
  ':(){ :|:& };:',
  'chmod -R 777',
  'mv /* /dev/null',
  '> /dev/sda',
  'shutdown',
  'reboot',
  'init 0',
  'init 6',
  'crontab -r',
  'iptables -F',
  'killall',
  'pkill -9',
];

// 高风险命令
export const HIGH_RISK_COMMANDS = [
  'rm -r',
  'rm -f',
  'dd',
  'chmod 777',
  'chown -R',
  'format',
  'wipefs',
];

// 中等风险命令
export const MEDIUM_RISK_COMMANDS = [
  'rm',
  'mv',
  'cp',
  'chmod',
  'chown',
  'kill',
  'systemctl stop',
  'systemctl disable',
];

// 命令描述映射
export const COMMAND_DESCRIPTIONS: Record<string, string> = {
  'rm': '删除文件或目录',
  'rm -rf': '递归强制删除目录及其内容（⚠️ 不可恢复）',
  'rm -r': '递归删除目录',
  'rm -f': '强制删除文件',
  'mv': '移动或重命名文件/目录',
  'cp': '复制文件或目录',
  'chmod': '修改文件权限',
  'chmod 777': '赋予所有用户完全权限（⚠️ 安全风险）',
  'chmod -R 777': '递归赋予所有用户完全权限（⚠️ 高危）',
  'chown': '修改文件所有者',
  'chown -R': '递归修改所有者',
  'dd': '低级别数据复制工具',
  'dd if=': '使用 dd 复制数据（可能覆盖磁盘）',
  'mkfs': '格式化文件系统',
  'format': '格式化磁盘',
  'wipefs': '擦除文件系统签名',
  'shutdown': '关闭系统',
  'reboot': '重启系统',
  'init 0': '关机命令',
  'init 6': '重启命令',
  'kill': '终止进程',
  'killall': '终止所有同名进程',
  'pkill': '根据名称终止进程',
  'pkill -9': '强制终止进程（SIGKILL）',
  'systemctl': '系统服务管理',
  'systemctl stop': '停止系统服务',
  'systemctl disable': '禁用系统服务',
  'crontab': '定时任务管理',
  'crontab -r': '删除所有定时任务',
  'iptables': '防火墙规则管理',
  'iptables -F': '清空所有防火墙规则',
};

// 默认应用设置
export const DEFAULT_SETTINGS = {
  language: 'zh-CN' as const,
  theme: 'dark' as const,
  fontSize: 14,
  fontFamily: 'Consolas, \'Courier New\', monospace',
  keepaliveInterval: 60,
  keepaliveCountMax: 3,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  showTerminalOutputPrompt: true,
  terminalTheme: 'dark',
  terminalScrollback: 3000,
  terminalCursorStyle: 'block' as const,
  terminalCursorBlink: true,
  terminalCopyOnSelect: false,
  terminalShellIntegration: true,
  agentSemanticSummaryContextLength: 12000,
  maxPersistedSessions: 8,
  maxScrollbackBytesPerSession: 150 * 1024,
};

// SSH 默认端口
export const DEFAULT_SSH_PORT = 22;
