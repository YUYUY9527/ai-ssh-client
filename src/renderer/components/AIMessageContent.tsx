import { useCallback, useMemo } from 'react';
import { Clipboard, Play, Check, AlertTriangle } from 'lucide-react';

interface ParsedCommand {
  command: string;
  description: string;
  isValid: boolean;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  step?: number;  // 步骤序号，如果有顺序依赖
}

// Linux 常用命令列表，用于验证
const VALID_LINUX_COMMANDS = [
  // 文件和目录操作
  'ls', 'cd', 'pwd', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'touch', 'cat', 'head', 'tail',
  'less', 'more', 'find', 'locate', 'which', 'whereis', 'stat', 'file', 'ln', 'tree',
  
  // 文本处理
  'grep', 'egrep', 'fgrep', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'tr', 'tee',
  'paste', 'split', 'comm', 'diff', 'patch',
  
  // 权限和用户
  'chmod', 'chown', 'chgrp', 'useradd', 'userdel', 'usermod', 'passwd', 'groupadd',
  'groupdel', 'su', 'sudo', 'visudo', 'id', 'who', 'whoami', 'w', 'last', 'lastlog',
  
  // 系统信息
  'uname', 'hostname', 'uptime', 'date', 'cal', 'df', 'du', 'free', 'top', 'htop',
  'ps', 'pkill', 'kill', 'killall', 'pgrep', 'pidof', 'nice', 'renice', 'nohup',
  
  // 网络
  'ip', 'ifconfig', 'netstat', 'ss', 'ping', 'traceroute', 'mtr', 'nslookup', 'dig',
  'host', 'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'nc', 'nmap',
  
  // 包管理
  'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'dpkg', 'rpm',
  
  // 服务和进程
  'systemctl', 'service', 'journalctl', 'crontab', 'at', 'batch',
  
  // Docker
  'docker', 'docker-compose', 'kubectl', 'helm',
  
  // Git
  'git', 'svn',
  
  // 压缩和归档
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'bunzip2', 'xz', 'unxz', '7z',
  
  // 其他
  'echo', 'printf', 'read', 'export', 'source', 'alias', 'unalias', 'history', 'man',
  'info', 'env', 'set', 'unset', 'type', 'which', 'clear', 'exit', 'logout',
  'shutdown', 'reboot', 'halt', 'poweroff', 'sync', 'mount', 'umount', 'fdisk',
  'parted', 'mkfs', 'fsck', 'lsblk', 'blkid', 'dd', 'hexdump', 'od', 'strings',
  
  // 文本编辑
  'vi', 'vim', 'nano', 'emacs', 'ed', 'sed',
  
  // 磁盘使用
  'lsattr', 'chattr', 'getfacl', 'setfacl',
  
  // 进程监控
  'vmstat', 'iostat', 'mpstat', 'lsof', 'fuser', 'strace', 'ltrace', 'time', 'timeout',
  
  // 日志
  'dmesg', 'journalctl',
  
  // 网络安全
  'iptables', 'firewalld', 'ufw', 'fail2ban',
  
  // 终端复用
  'screen', 'tmux', 'byobu',
  
  // 远程操作
  'ssh-keygen', 'ssh-copy-id', 'expect',
  
  // 开发工具
  'node', 'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'conda', 'cargo', 'rustc', 'go',
  'python', 'python3', 'java', 'javac', 'mvn', 'gradle', 'perl', 'ruby', 'php',
  
  // 容器和虚拟化
  'podman', 'buildah', 'skopeo', 'ctr', 'crictl', 'nerdctl',
  
  // 云工具
  'aws', 'az', 'gcloud', 'terraform', 'ansible', 'vagrant',
  
  // 数据库
  'mysql', 'psql', 'mongosh', 'redis-cli', 'sqlite3',
];

// 危险命令列表
const DANGEROUS_COMMANDS = [
  'rm -rf /', 'rm -rf /*', ':(){:|:&};:', 'forkbomb', '> /dev/sda',
  'dd if=/dev/zero of=/dev/sda', 'mkfs', 'fdisk /dev/sda',
];

// 高风险命令
const HIGH_RISK_COMMANDS = [
  'rm -rf', 'rm -r', 'dd ', 'mkfs', 'fdisk', 'parted',
  ':(){:|:&};:', '> /dev/', '2>&1',
];

// 从行中提取步骤序号
function extractStepFromLine(line: string): { step: number | undefined; content: string } {
  const trimmed = line.trim();
  
  // 匹配阿拉伯数字序号：1. 2. 12. 
  const numMatch = trimmed.match(/^(\d+)[\.、]\s*(.+)$/);
  if (numMatch) {
    return { step: parseInt(numMatch[1], 10), content: numMatch[2] };
  }
  
  // 匹配中文序号：第一步、第二步、第3步
  const chineseNumMatch = trimmed.match(/^第([一二三四五六七八九十百千\d]+)步[、和]?\s*(.*)$/);
  if (chineseNumMatch) {
    const chineseToNum: Record<string, number> = {
      '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
      '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
    };
    let step = chineseToNum[chineseNumMatch[1]];
    if (!step) {
      step = parseInt(chineseNumMatch[1], 10);
    }
    if (step) {
      return { step, content: chineseNumMatch[2] };
    }
  }
  
  // 匹配 "步骤X" 或 "Step X"：步骤1、步骤2
  const stepMatch = trimmed.match(/^(?:步骤|Step)\s*(\d+)[\s:：]*(.*)$/i);
  if (stepMatch) {
    return { step: parseInt(stepMatch[1], 10), content: stepMatch[2] };
  }
  
  return { step: undefined, content: trimmed };
}

// 检测内容是否包含明确的步骤标记
function hasExplicitStepMarkers(content: string): boolean {
  const lines = content.split('\n');
  let stepCount = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // 检查是否包含明确的步骤标记
    const hasStepMarker = 
      /^\d+[\.、]\s/.test(trimmed) ||           // 1. 2. 3.
      /^第[一二三四五六七八九十]+步/.test(trimmed) ||  // 第一步、第二步
      /^(?:步骤|Step)\s*\d+/i.test(trimmed);    // 步骤1、Step 2
    
    if (hasStepMarker) {
      stepCount++;
    }
  }
  
  // 只有当超过一半的命令有步骤标记时，才认为是步骤化内容
  return stepCount >= 2;
}

// 解析 AI 响应中的命令
export function parseAICommands(content: string): ParsedCommand[] {
  const commands: ParsedCommand[] = [];
  const lines = content.split('\n');
  
  // 正则：匹配 "- command: description" 或 "- `command`: description" 格式
  const listItemRegex = /^[-\*]\s*`?([^\s:`'"]+(?:\s+[^\s:`'"]+)*)`?\s*[:：]\s*(.+)$/;
  
  // 先检测内容是否有明确的步骤标记
  const explicitSteps = hasExplicitStepMarkers(content);
  let currentStep = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // 跳过空行
    if (!trimmed) continue;
    
    // 先提取步骤号（仅当内容有明确步骤标记时）
    let step: number | undefined = undefined;
    if (explicitSteps) {
      const extracted = extractStepFromLine(trimmed);
      if (extracted.step !== undefined) {
        currentStep = extracted.step;
        step = extracted.step;
      } else if (currentStep > 0) {
        // 如果当前行没有步骤号但之前有，继续递增
        currentStep++;
        step = currentStep;
      }
    }
    
    // 尝试匹配列表项格式：- command: description
    const listMatch = trimmed.match(listItemRegex);
    if (listMatch) {
      const cmd = listMatch[1].trim();
      const desc = listMatch[2].trim();
      
      // 验证命令
      const isValid = validateCommand(cmd);
      const riskLevel = getRiskLevel(cmd);
      
      commands.push({ command: cmd, description: desc, isValid, riskLevel, step });
      continue;
    }
    
    // 尝试匹配代码块中的命令（以 $ 或 # 开头）
    if (trimmed.startsWith('$ ') || trimmed.startsWith('# ')) {
      const cmd = trimmed.replace(/^[\$#]\s*/, '').trim();
      if (cmd && cmd.length > 1) {
        const isValid = validateCommand(cmd);
        const riskLevel = getRiskLevel(cmd);
        
        commands.push({ command: cmd, description: '', isValid, riskLevel, step });
      }
    }
  }
  
  return commands;
}

// 验证命令是否有效
function validateCommand(cmd: string): boolean {
  if (!cmd || cmd.length < 2) return false;
  
  // 排除纯描述性文字
  const excludePatterns = [
    /^镜像相关/, /^容器相关/, /^网络相关/, /^卷.*命令/, /^其他.*命令/,
    /^常用参数/, /^含义/, /^如果你/, /^参数.*含义/, /^Docker.*命令/,
    /^命令/, /^说明/, /^描述/, /^示例/, /^用法/, /^格式/,
    /^参数/, /^选项/, /^返回值/, /^类型/, /^名称/,
    /^使用/, /^进行/, /^完成/, /^获取/, /^查看/,
    /[\u4e00-\u9fa5]/, // 包含中文的不是命令
  ];
  
  for (const pattern of excludePatterns) {
    if (pattern.test(cmd)) return false;
  }
  
  // 提取命令的第一个词
  const firstWord = cmd.split(/\s+/)[0].toLowerCase();
  
  // 检查是否是有效的 Linux 命令
  if (VALID_LINUX_COMMANDS.includes(firstWord)) {
    return true;
  }
  
  // 检查是否包含常见命令关键词
  const commandKeywords = [
    'docker', 'kubectl', 'git', 'npm', 'yarn', 'pip', 'apt', 'yum', 'dnf',
    'systemctl', 'service', 'chmod', 'chown', 'ssh', 'scp', 'rsync',
    'tar', 'zip', 'grep', 'sed', 'awk', 'find', 'curl', 'wget',
  ];
  
  for (const keyword of commandKeywords) {
    if (cmd.toLowerCase().includes(keyword)) {
      return true;
    }
  }
  
  return false;
}

// 获取命令风险等级
function getRiskLevel(cmd: string): 'low' | 'medium' | 'high' | 'critical' {
  const lowerCmd = cmd.toLowerCase();
  
  for (const dangerous of DANGEROUS_COMMANDS) {
    if (lowerCmd.includes(dangerous.toLowerCase())) {
      return 'critical';
    }
  }
  
  for (const highRisk of HIGH_RISK_COMMANDS) {
    if (lowerCmd.includes(highRisk.toLowerCase())) {
      return 'high';
    }
  }
  
  // 涉及删除或修改的命令
  if (/rm\s+|-rf|chmod\s+777|chmod\s+000|mkfs|fdisk/.test(lowerCmd)) {
    return 'medium';
  }
  
  return 'low';
}

// 移除已提取的命令行，保留其他说明文字
export function extractDescriptions(content: string, commands: ParsedCommand[]): string[] {
  const descriptions: string[] = [];
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // 检查是否是命令列表项
    const listItemRegex = /^[-\*]\s*`?([^\s:`'"]+(?:\s+[^\s:`'"]+)*)`?\s*[:：]/;
    const codeLineRegex = /^\$?\s*[a-zA-Z]/;
    
    if (!listItemRegex.test(trimmed) && !codeLineRegex.test(trimmed)) {
      // 保留说明性文字
      if (trimmed.length > 5) {
        descriptions.push(trimmed);
      }
    }
  }
  
  return descriptions;
}

interface CommandCardProps {
  command: string;
  description?: string;
  riskLevel?: 'low' | 'medium' | 'high' | 'critical';
  step?: number;  // 步骤序号
  onPaste: (command: string) => void;
  onExecute: (command: string) => void;
}

export function CommandCard({ command, description, riskLevel = 'low', step, onPaste, onExecute }: CommandCardProps) {
  const handlePaste = useCallback(() => {
    onPaste(command);
  }, [command, onPaste]);

  const handleExecute = useCallback(() => {
    onExecute(command);
  }, [command, onExecute]);

  const riskColors = {
    low: 'border-slate-200 dark:border-slate-700',
    medium: 'border-yellow-500 dark:border-yellow-600',
    high: 'border-orange-500 dark:border-orange-600',
    critical: 'border-red-500 dark:border-red-600',
  };

  const riskBgColors = {
    low: 'bg-slate-50 dark:bg-slate-900',
    medium: 'bg-yellow-50 dark:bg-yellow-900/30',
    high: 'bg-orange-50 dark:bg-orange-900/30',
    critical: 'bg-red-50 dark:bg-red-900/30',
  };

  return (
    <div className={`rounded-lg border ${riskColors[riskLevel]} ${riskBgColors[riskLevel]} p-3 mb-2 transition-all hover:shadow-md`}>
      {/* 命令行 */}
      <div className="flex items-center gap-2 mb-2">
        {/* 步骤号 */}
        {step !== undefined ? (
          <div className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">
            {step}
          </div>
        ) : null}
        <code className={`flex-1 text-green-600 dark:text-green-400 font-mono text-sm bg-transparent break-all ${step !== undefined ? '' : 'ml-0'}`}>
          {command}
        </code>
        {riskLevel === 'high' || riskLevel === 'critical' ? (
          <AlertTriangle className={`w-4 h-4 flex-shrink-0 ${
            riskLevel === 'critical' ? 'text-red-500' : 'text-orange-500'
          }`} />
        ) : null}
      </div>
      
      {/* 说明文字 */}
      {description && (
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
          {description}
        </p>
      )}
      
      {/* 按钮组 */}
      <div className="flex items-center gap-2">
        <button
          onClick={handlePaste}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-slate-700 dark:text-slate-300"
          title="粘贴到终端输入栏"
        >
          <Clipboard className="w-3.5 h-3.5" />
          粘贴
        </button>
        <button
          onClick={handleExecute}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            riskLevel === 'critical'
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : riskLevel === 'high'
              ? 'bg-orange-600 hover:bg-orange-500 text-white'
              : 'bg-green-600 hover:bg-green-500 text-white'
          }`}
          title="直接执行命令"
        >
          <Play className="w-3.5 h-3.5" />
          执行
        </button>
      </div>
    </div>
  );
}

interface AIMessageContentProps {
  content: string;
  onPasteCommand: (command: string) => void;
  onExecuteCommand: (command: string) => void;
}

export function AIMessageContent({ content, onPasteCommand, onExecuteCommand }: AIMessageContentProps) {
  const commands = useMemo(() => parseAICommands(content), [content]);
  const descriptions = useMemo(() => extractDescriptions(content, commands), [content, commands]);

  if (commands.length === 0) {
    // 没有命令时，直接显示文本
    return (
      <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">
        {content}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 说明文字（如果有的话） */}
      {descriptions.length > 0 && (
        <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
          {descriptions.map((desc, i) => (
            <p key={i} className="mb-1">{desc}</p>
          ))}
        </div>
      )}
      
      {/* 命令列表 */}
      <div className="space-y-2">
        {commands.map((cmd, index) => (
          <CommandCard
            key={index}
            command={cmd.command}
            description={cmd.description}
            riskLevel={cmd.riskLevel}
            step={cmd.step}
            onPaste={onPasteCommand}
            onExecute={onExecuteCommand}
          />
        ))}
      </div>
    </div>
  );
}
