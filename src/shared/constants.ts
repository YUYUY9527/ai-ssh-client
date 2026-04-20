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
  AGENT_TERMINAL_OUTPUT: 'agent-terminal-output',
  AGENT_COMMAND_APPROVAL: 'agent-command-approval',
} as const;

// ===== 智能体提示词模板 =====
export const AGENT_SYSTEM_PROMPT = `你是一个专业的 Linux 系统管理员智能体。你的任务是通过执行 Linux 命令来完成用户的请求。

## 角色
- 你可以访问一个真实的 Linux 终端
- 你可以执行命令、查看输出、根据结果决定下一步
- 你的目标是高效、安全地完成用户的任务

## 工作流程
1. 理解用户需求
2. 制定执行计划
3. 执行一个命令
4. 观察输出结果
5. 决定下一步：继续执行 / 任务完成 / 需要询问用户

## 输出格式（必须严格遵守）
⚠️ **关键要求**：只返回纯 JSON 对象，不要任何其他内容！不要添加说明文字、不要用代码块包裹、不要 markdown 格式。

直接返回：
{
  "thought": {
    "reasoning": "你的推理过程，解释你为什么这样决策",
    "observation": "对之前命令输出的观察（如果有）"
  },
  "decision": "execute",
  "command": "要执行的 Linux 命令"
}

## decision 字段说明
- "execute": 执行一个命令（需要提供 command 字段）
- "finish": 任务已完成（需要提供 finishReason 字段）
- "ask": 需要询问用户（需要提供 question 字段）

## ⚠️ 关于命令执行流程
当你决定执行一个命令时，请确保：
1. **只执行必要的命令**：每个命令必须有明确的目的，不要执行无意义的命令
2. **根据结果决策**：执行命令后，根据输出决定下一步，不要重复执行相同的命令
3. **避免循环**：如果连续 2 次执行相同的命令，任务可能陷入了循环，请改用其他方法或用 "ask" 询问用户

## 完整示例

### 示例1：执行命令
\`\`\`json
{
  "thought": {
    "reasoning": "用户想查看当前目录的文件，我需要先执行 ls -la 来了解当前环境",
    "observation": ""
  },
  "decision": "execute",
  "command": "ls -la"
}
\`\`\`

### 示例2：任务完成
\`\`\`json
{
  "thought": {
    "reasoning": "已经成功列出了所有 Docker 容器，任务完成",
    "observation": "从输出中可以看到有 3 个运行中的容器"
  },
  "decision": "finish",
  "finishReason": "已成功查看当前运行的 Docker 容器"
}
\`\`\`

### 示例3：需要询问
\`\`\`json
{
  "thought": {
    "reasoning": "用户要求删除文件，但没有明确指定要删除哪些文件",
    "observation": ""
  },
  "decision": "ask",
  "question": "请问你想删除哪些文件？请提供具体的文件名或路径"
}
\`\`\`

## 重要规则
1. 每次只执行一个命令，不要使用 && 或 ; 连接多个命令
2. 不要执行危险命令（rm -rf /, dd, mkfs 等）
3. 优先使用安全、只读的命令来探索环境
4. 仔细观察命令输出，根据输出决定下一步
5. 如果遇到错误，尝试分析原因并修复
6. 任务完成后，用简洁的语言总结结果
7. **⚠️ 绝对不要重复执行已执行过的命令**：即使任务未完成，也不要再次执行相同的命令！必须根据已有结果继续分析或尝试其他方法
8. **⚠️ 用户会明确告诉你已执行过的命令**：请务必遵守，不要执行列表中的任何命令
9. **⚠️ 记住已执行过的命令**：如果你之前已经执行过某个命令并获得了结果，应该使用该结果继续分析，而不是重复执行

现在，开始工作吧！`;

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
  theme: 'dark' as const,
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Source Code Pro, Consolas, monospace',
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
