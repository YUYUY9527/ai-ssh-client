// IPC 通道常量
export const IPC_CHANNELS = {
  // SSH
  SSH_CONNECT: 'ssh-connect',
  SSH_DISCONNECT: 'ssh-disconnect',
  SSH_EXECUTE: 'ssh-execute',
  SSH_EXECUTE_SYNC: 'ssh-execute-sync',
  SSH_DATA: 'ssh-data',
  SSH_ERROR: 'ssh-error',
  SSH_CLOSE: 'ssh-close',
  SSH_GET_SESSIONS: 'ssh-get-sessions',
  SSH_RECONNECT: 'ssh-reconnect',
  SSH_TEST_CONNECTION: 'ssh-test-connection',
  SSH_RESIZE: 'ssh-resize',

  // AI
  AI_CHAT: 'ai-chat',
  AI_CANCEL_CHAT: 'ai-cancel-chat',
  AI_GET_PROVIDERS: 'ai-get-providers',
  AI_SAVE_PROVIDER: 'ai-save-provider',
  AI_DELETE_PROVIDER: 'ai-delete-provider',
  AI_TEST_PROVIDER: 'ai-test-provider',
  AI_SET_ACTIVE_PROVIDER: 'ai-set-active-provider',
  AI_GET_PROVIDER_SECRET_STATUS: 'ai-get-provider-secret-status',

  // 连接管理
  GET_CONNECTIONS: 'get-connections',
  SAVE_CONNECTION: 'save-connection',
  DELETE_CONNECTION: 'delete-connection',

  // 命令历史
  GET_COMMAND_HISTORY: 'get-command-history',
  ADD_COMMAND_HISTORY: 'add-command-history',
  CLEAR_COMMAND_HISTORY: 'clear-command-history',

  // 快速命令
  GET_QUICK_COMMANDS: 'get-quick-commands',
  SAVE_QUICK_COMMAND: 'save-quick-command',
  DELETE_QUICK_COMMAND: 'delete-quick-command',

  // 快速命令分组
  GET_QUICK_COMMAND_GROUPS: 'get-quick-command-groups',
  SAVE_QUICK_COMMAND_GROUP: 'save-quick-command-group',
  DELETE_QUICK_COMMAND_GROUP: 'delete-quick-command-group',

  // 设置
  GET_SETTINGS: 'get-settings',
  SAVE_SETTINGS: 'save-settings',
  SHOW_SYSTEM_NOTIFICATION: 'show-system-notification',

  // 文件选择
  SELECT_FILE: 'select-file',
  READ_PRIVATE_KEY_FILE: 'read-private-key-file',

  // SFTP 文件传输
  SFTP_LIST_DIRECTORY: 'sftp-list-directory',
  SFTP_DOWNLOAD_FILE: 'sftp-download-file',
  SFTP_UPLOAD_FILE: 'sftp-upload-file',

  // 智能体模式
  AGENT_START_TASK: 'agent-start-task',
  AGENT_STOP_TASK: 'agent-stop-task',
  AGENT_PAUSE_TASK: 'agent-pause-task',
  AGENT_RESUME_TASK: 'agent-resume-task',
  AGENT_EXECUTE_COMMAND: 'agent-execute-command',
  AGENT_EXEC_AWAIT: 'agent-exec-await',
  AGENT_CANCEL_EXEC: 'agent-cancel-exec',
  AGENT_TERMINAL_OUTPUT: 'agent-terminal-output',
  AGENT_COMMAND_APPROVAL: 'agent-command-approval',
} as const;

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
  terminalTheme: 'dark',  // 默认终端主题
  agentTaskContextRounds: 3,  // 默认保留3轮任务上下文
};

// SSH 默认端口
export const DEFAULT_SSH_PORT = 22;
