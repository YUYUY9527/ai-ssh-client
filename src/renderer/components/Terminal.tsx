import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { Search, ZoomIn, ZoomOut, Copy, Clipboard, Terminal as TerminalIcon, Edit3 } from 'lucide-react';
import { useConnectionStore } from '../store/useConnectionStore';
import { useTheme } from '../hooks/useTheme';
import type { CommandHistoryItem, QuickCommand, AppSettings } from '../../shared/types';

// 右键菜单组件
function ContextMenu({
  x,
  y,
  onCopy,
  onPaste,
  onPasteToInput,
  onClose,
}: {
  x: number;
  y: number;
  onCopy: () => void;
  onPaste: () => void;
  onPasteToInput: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  useEffect(() => {
    if (!menuRef.current) return;

    const menuRect = menuRef.current.getBoundingClientRect();
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let newX = x;
    let newY = y;

    // 检查是否超出右边界
    if (x + menuRect.width > windowWidth) {
      newX = windowWidth - menuRect.width - 8; // 留 8px 边距
    }

    // 检查是否超出下边界
    if (y + menuRect.height > windowHeight) {
      newY = windowHeight - menuRect.height - 8; // 留 8px 边距
    }

    // 确保不会超出左边界和上边界
    newX = Math.max(8, newX);
    newY = Math.max(8, newY);

    setPosition({ x: newX, y: newY });
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[160px]"
      style={{ left: position.x, top: position.y }}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onCopy(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <Copy className="w-4 h-4" />
        复制
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onPaste(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <Clipboard className="w-4 h-4" />
        粘贴
      </button>
      <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
      <button
        onClick={(e) => { e.stopPropagation(); onPasteToInput(); }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <Edit3 className="w-4 h-4" />
        粘贴到终端输入栏
      </button>
    </div>
  );
}

// 常用 Linux 命令
const COMMON_COMMANDS = [
  // 文件和目录操作
  { command: 'ls', description: '列出目录内容' },
  { command: 'ls -la', description: '列出详细信息' },
  { command: 'ls -lh', description: '人类可读格式' },
  { command: 'ls -lt', description: '按时间排序' },
  { command: 'cd', description: '切换目录' },
  { command: 'cd ..', description: '返回上级目录' },
  { command: 'cd ~', description: '回到家目录' },
  { command: 'cd -', description: '返回上次目录' },
  { command: 'pwd', description: '显示当前目录' },
  { command: 'mkdir', description: '创建目录' },
  { command: 'mkdir -p', description: '递归创建目录' },
  { command: 'rm', description: '删除文件' },
  { command: 'rm -rf', description: '强制删除目录' },
  { command: 'rm -i', description: '交互式删除' },
  { command: 'cp', description: '复制文件' },
  { command: 'cp -r', description: '递归复制目录' },
  { command: 'cp -a', description: '保留属性复制' },
  { command: 'mv', description: '移动/重命名' },
  { command: 'touch', description: '创建空文件' },
  { command: 'ln', description: '创建硬链接' },
  { command: 'ln -s', description: '创建软链接' },
  
  // 查看文件内容
  { command: 'cat', description: '查看文件内容' },
  { command: 'cat -n', description: '显示行号' },
  { command: 'less', description: '分页查看文件' },
  { command: 'more', description: '分页查看文件' },
  { command: 'head', description: '查看文件开头' },
  { command: 'head -n 20', description: '查看前20行' },
  { command: 'tail', description: '查看文件结尾' },
  { command: 'tail -n 20', description: '查看后20行' },
  { command: 'tail -f', description: '实时跟踪文件' },
  { command: 'tail -F', description: '跟踪文件（重试）' },
  { command: 'wc', description: '统计文件信息' },
  { command: 'wc -l', description: '统计行数' },
  { command: 'wc -w', description: '统计词数' },
  
  // 搜索和查找
  { command: 'grep', description: '搜索文本' },
  { command: 'grep -i', description: '忽略大小写搜索' },
  { command: 'grep -r', description: '递归搜索目录' },
  { command: 'grep -n', description: '显示行号' },
  { command: 'grep -v', description: '反向匹配' },
  { command: 'grep -A 5', description: '显示后5行' },
  { command: 'grep -B 5', description: '显示前5行' },
  { command: 'grep -C 5', description: '显示前后5行' },
  { command: 'find', description: '查找文件' },
  { command: 'find . -name', description: '按名称查找' },
  { command: 'find . -type f', description: '查找文件' },
  { command: 'find . -type d', description: '查找目录' },
  { command: 'find . -mtime -7', description: '7天内修改的文件' },
  { command: 'find . -size +100M', description: '大于100M的文件' },
  { command: 'locate', description: '快速查找文件' },
  { command: 'which', description: '查找命令路径' },
  { command: 'whereis', description: '查找命令相关文件' },
  
  // 文件权限和属性
  { command: 'chmod', description: '修改权限' },
  { command: 'chmod +x', description: '添加执行权限' },
  { command: 'chmod 755', description: '设置755权限' },
  { command: 'chmod 644', description: '设置644权限' },
  { command: 'chown', description: '修改所有者' },
  { command: 'chown -R', description: '递归修改所有者' },
  { command: 'chgrp', description: '修改组' },
  { command: 'umask', description: '设置默认权限' },
  { command: 'lsattr', description: '查看文件属性' },
  { command: 'chattr', description: '修改文件属性' },
  
  // 压缩和解压
  { command: 'tar', description: '压缩/解压' },
  { command: 'tar -cvf', description: '创建tar包' },
  { command: 'tar -xvf', description: '解压tar包' },
  { command: 'tar -czvf', description: '创建tar.gz' },
  { command: 'tar -xzvf', description: '解压tar.gz' },
  { command: 'tar -cjvf', description: '创建tar.bz2' },
  { command: 'tar -xjvf', description: '解压tar.bz2' },
  { command: 'zip', description: '创建zip压缩' },
  { command: 'zip -r', description: '递归压缩目录' },
  { command: 'unzip', description: '解压zip文件' },
  { command: 'unzip -l', description: '查看zip内容' },
  { command: 'gzip', description: 'gzip压缩' },
  { command: 'gunzip', description: 'gzip解压' },
  { command: 'bzip2', description: 'bzip2压缩' },
  { command: 'bunzip2', description: 'bzip2解压' },
  { command: 'xz', description: 'xz压缩' },
  { command: 'unxz', description: 'xz解压' },
  
  // 系统信息和监控
  { command: 'uname', description: '系统信息' },
  { command: 'uname -a', description: '全部系统信息' },
  { command: 'hostname', description: '主机名' },
  { command: 'hostname -I', description: 'IP地址' },
  { command: 'uptime', description: '运行时间' },
  { command: 'whoami', description: '当前用户' },
  { command: 'id', description: '用户ID信息' },
  { command: 'w', description: '在线用户' },
  { command: 'who', description: '登录用户' },
  { command: 'last', description: '最近登录' },
  { command: 'date', description: '显示日期时间' },
  { command: 'cal', description: '显示日历' },
  { command: 'top', description: '查看进程' },
  { command: 'htop', description: '交互式进程查看' },
  { command: 'iotop', description: 'IO监控' },
  { command: 'vmstat', description: '虚拟内存统计' },
  { command: 'iostat', description: 'IO统计' },
  { command: 'sar', description: '系统活动报告' },
  { command: 'dmesg', description: '内核消息' },
  { command: 'dmesg -T', description: '带时间的内核消息' },
  
  // 磁盘和内存
  { command: 'df', description: '查看磁盘使用' },
  { command: 'df -h', description: '人类可读格式' },
  { command: 'df -i', description: '查看inode使用' },
  { command: 'du', description: '查看目录大小' },
  { command: 'du -sh', description: '汇总目录大小' },
  { command: 'du -sh *', description: '当前目录各文件大小' },
  { command: 'du -d 1', description: '一级目录大小' },
  { command: 'free', description: '查看内存使用' },
  { command: 'free -h', description: '人类可读格式' },
  { command: 'free -m', description: 'MB单位' },
  { command: 'swapon', description: '查看交换分区' },
  { command: 'swapoff', description: '关闭交换分区' },
  { command: 'mount', description: '挂载文件系统' },
  { command: 'umount', description: '卸载文件系统' },
  { command: 'lsblk', description: '块设备列表' },
  { command: 'fdisk -l', description: '磁盘分区列表' },
  { command: 'parted -l', description: '分区信息' },
  
  // 进程管理
  { command: 'ps', description: '查看进程' },
  { command: 'ps aux', description: '查看所有进程' },
  { command: 'ps auxww', description: '完整显示' },
  { command: 'ps -ef', description: '全格式显示' },
  { command: 'pgrep', description: '按名称查找进程' },
  { command: 'pkill', description: '按名称终止进程' },
  { command: 'kill', description: '终止进程' },
  { command: 'kill -9', description: '强制终止进程' },
  { command: 'kill -l', description: '查看信号列表' },
  { command: 'killall', description: '终止所有同名进程' },
  { command: 'nohup', description: '后台运行' },
  { command: 'bg', description: '后台执行' },
  { command: 'fg', description: '前台执行' },
  { command: 'jobs', description: '查看后台任务' },
  { command: 'screen', description: '终端复用' },
  { command: 'tmux', description: '终端复用' },
  
  // 网络相关
  { command: 'ip addr', description: '查看IP地址' },
  { command: 'ip link', description: '查看网络接口' },
  { command: 'ip route', description: '查看路由表' },
  { command: 'ifconfig', description: '网络接口配置' },
  { command: 'netstat', description: '网络统计' },
  { command: 'netstat -tlnp', description: '监听端口' },
  { command: 'netstat -tulnp', description: '所有监听端口' },
  { command: 'netstat -an', description: '所有连接' },
  { command: 'ss', description: 'socket统计' },
  { command: 'ss -tlnp', description: '监听端口' },
  { command: 'ss -s', description: 'socket摘要' },
  { command: 'ping', description: '测试连通性' },
  { command: 'ping -c 4', description: 'ping 4次' },
  { command: 'traceroute', description: '路由追踪' },
  { command: 'mtr', description: '综合网络诊断' },
  { command: 'nslookup', description: 'DNS查询' },
  { command: 'dig', description: 'DNS查询' },
  { command: 'host', description: 'DNS查询' },
  { command: 'curl', description: 'HTTP请求' },
  { command: 'curl -I', description: '仅显示头部' },
  { command: 'curl -v', description: '详细输出' },
  { command: 'curl -O', description: '下载文件' },
  { command: 'curl -L', description: '跟随重定向' },
  { command: 'wget', description: '下载文件' },
  { command: 'wget -c', description: '断点续传' },
  { command: 'wget -r', description: '递归下载' },
  { command: 'ssh', description: 'SSH连接' },
  { command: 'ssh -p', description: '指定端口' },
  { command: 'ssh -i', description: '指定密钥' },
  { command: 'scp', description: '安全复制' },
  { command: 'scp -r', description: '递归复制' },
  { command: 'scp -P', description: '指定端口' },
  { command: 'rsync', description: '文件同步' },
  { command: 'rsync -avz', description: '归档模式同步' },
  { command: 'rsync -avz --delete', description: '同步并删除' },
  { command: 'telnet', description: 'telnet连接' },
  { command: 'nc', description: 'netcat工具' },
  { command: 'tcpdump', description: '抓包工具' },
  { command: 'iptables', description: '防火墙配置' },
  { command: 'firewall-cmd', description: 'firewalld配置' },
  { command: 'ufw', description: 'Ubuntu防火墙' },
  
  // 包管理（Debian/Ubuntu）
  { command: 'apt update', description: '更新软件包列表' },
  { command: 'apt upgrade', description: '升级软件包' },
  { command: 'apt install', description: '安装软件' },
  { command: 'apt remove', description: '删除软件' },
  { command: 'apt purge', description: '彻底删除' },
  { command: 'apt autoremove', description: '自动删除' },
  { command: 'apt search', description: '搜索软件包' },
  { command: 'apt show', description: '显示软件包信息' },
  { command: 'apt list --installed', description: '已安装软件' },
  { command: 'dpkg -i', description: '安装deb包' },
  { command: 'dpkg -l', description: '列出已安装包' },
  { command: 'dpkg -L', description: '列出包文件' },
  
  // 包管理（RHEL/CentOS）
  { command: 'yum install', description: '安装软件' },
  { command: 'yum update', description: '更新软件' },
  { command: 'yum remove', description: '删除软件' },
  { command: 'yum search', description: '搜索软件' },
  { command: 'yum list installed', description: '已安装软件' },
  { command: 'dnf install', description: '安装软件' },
  { command: 'rpm -i', description: '安装rpm包' },
  { command: 'rpm -qa', description: '查询已安装包' },
  { command: 'rpm -ql', description: '列出包文件' },
  
  // 服务管理
  { command: 'systemctl status', description: '服务状态' },
  { command: 'systemctl start', description: '启动服务' },
  { command: 'systemctl stop', description: '停止服务' },
  { command: 'systemctl restart', description: '重启服务' },
  { command: 'systemctl reload', description: '重新加载' },
  { command: 'systemctl enable', description: '开机自启' },
  { command: 'systemctl disable', description: '禁止开机自启' },
  { command: 'systemctl is-enabled', description: '查看是否自启' },
  { command: 'systemctl list-units', description: '列出单元' },
  { command: 'systemctl list-unit-files', description: '列出单元文件' },
  { command: 'systemctl daemon-reload', description: '重载配置' },
  { command: 'service', description: '服务管理' },
  { command: 'chkconfig', description: '服务自启管理' },
  
  // 日志查看
  { command: 'journalctl', description: '系统日志' },
  { command: 'journalctl -u', description: '查看服务日志' },
  { command: 'journalctl -f', description: '实时跟踪' },
  { command: 'journalctl -n 100', description: '最近100行' },
  { command: 'journalctl --since today', description: '今天的日志' },
  { command: 'journalctl -p err', description: '错误日志' },
  { command: 'dmesg', description: '内核日志' },
  { command: 'tail -f /var/log/syslog', description: '系统日志' },
  { command: 'tail -f /var/log/messages', description: '系统消息' },
  { command: 'tail -f /var/log/auth.log', description: '认证日志' },
  { command: 'tail -f /var/log/secure', description: '安全日志' },
  
  // 用户和组管理
  { command: 'useradd', description: '创建用户' },
  { command: 'useradd -m', description: '创建用户并目录' },
  { command: 'userdel', description: '删除用户' },
  { command: 'userdel -r', description: '删除用户及目录' },
  { command: 'usermod', description: '修改用户' },
  { command: 'passwd', description: '修改密码' },
  { command: 'groupadd', description: '创建组' },
  { command: 'groupdel', description: '删除组' },
  { command: 'groupmod', description: '修改组' },
  { command: 'gpasswd', description: '组密码管理' },
  { command: 'id', description: '用户信息' },
  { command: 'groups', description: '用户组' },
  { command: 'su', description: '切换用户' },
  { command: 'su -', description: '完全切换' },
  { command: 'sudo', description: '以root执行' },
  { command: 'sudo -i', description: 'root登录' },
  { command: 'visudo', description: '编辑sudoers' },
  
  // 文本编辑和处理
  { command: 'nano', description: 'nano编辑器' },
  { command: 'vim', description: 'Vim编辑器' },
  { command: 'vi', description: 'Vi编辑器' },
  { command: 'sed', description: '流编辑器' },
  { command: 'sed -i', description: '原地编辑' },
  { command: 'sed s/old/new/', description: '替换文本' },
  { command: 'awk', description: '文本处理' },
  { command: 'awk \'{print $1}\'', description: '打印第一列' },
  { command: 'cut', description: '切割文本' },
  { command: 'cut -d: -f1', description: '按:分割取第一列' },
  { command: 'sort', description: '排序' },
  { command: 'uniq', description: '去重' },
  { command: 'wc', description: '统计' },
  { command: 'tr', description: '字符替换' },
  { command: 'paste', description: '合并行' },
  { command: 'split', description: '分割文件' },
  { command: 'join', description: '连接文件' },
  { command: 'diff', description: '比较文件' },
  { command: 'diff -u', description: '统一格式' },
  { command: 'patch', description: '打补丁' },
  { command: 'cmp', description: '比较文件' },
  { command: 'comm', description: '比较已排序文件' },
  
  // 环境变量和Shell
  { command: 'echo', description: '输出文本' },
  { command: 'echo $PATH', description: '显示PATH' },
  { command: 'export', description: '设置环境变量' },
  { command: 'export VAR=value', description: '设置变量' },
  { command: 'env', description: '显示环境变量' },
  { command: 'set', description: '显示所有变量' },
  { command: 'unset', description: '删除变量' },
  { command: 'source', description: '执行脚本' },
  { command: '.', description: '执行脚本' },
  { command: 'alias', description: '查看别名' },
  { command: 'alias ll="ls -la"', description: '设置别名' },
  { command: 'unalias', description: '删除别名' },
  { command: 'history', description: '命令历史' },
  { command: 'history -c', description: '清空历史' },
  { command: '!', description: '执行历史命令' },
  { command: '!!', description: '执行上一条命令' },
  
  // Git相关
  { command: 'git status', description: 'Git状态' },
  { command: 'git add', description: 'Git添加' },
  { command: 'git add .', description: '添加所有' },
  { command: 'git add -u', description: '添加更新的' },
  { command: 'git commit', description: 'Git提交' },
  { command: 'git commit -m', description: '带消息提交' },
  { command: 'git commit -am', description: '添加并提交' },
  { command: 'git push', description: 'Git推送' },
  { command: 'git push origin', description: '推送到origin' },
  { command: 'git push -u origin', description: '推送并设置上游' },
  { command: 'git pull', description: 'Git拉取' },
  { command: 'git pull origin', description: '从origin拉取' },
  { command: 'git fetch', description: '获取更新' },
  { command: 'git clone', description: '克隆仓库' },
  { command: 'git init', description: '初始化仓库' },
  { command: 'git branch', description: '查看分支' },
  { command: 'git branch -a', description: '查看所有分支' },
  { command: 'git checkout', description: '切换分支' },
  { command: 'git checkout -b', description: '创建并切换' },
  { command: 'git merge', description: '合并分支' },
  { command: 'git rebase', description: '变基' },
  { command: 'git log', description: '查看日志' },
  { command: 'git log --oneline', description: '简洁日志' },
  { command: 'git log --graph', description: '图形化日志' },
  { command: 'git diff', description: '查看差异' },
  { command: 'git diff --staged', description: '查看暂存差异' },
  { command: 'git reset', description: '重置' },
  { command: 'git reset --hard', description: '硬重置' },
  { command: 'git stash', description: '暂存修改' },
  { command: 'git stash pop', description: '恢复暂存' },
  { command: 'git stash list', description: '查看暂存列表' },
  { command: 'git remote', description: '查看远程仓库' },
  { command: 'git remote -v', description: '详细远程信息' },
  { command: 'git tag', description: '查看标签' },
  { command: 'git tag -a', description: '创建标签' },
  
  // Docker相关
  { command: 'docker ps', description: '查看运行的容器' },
  { command: 'docker ps -a', description: '查看所有容器' },
  { command: 'docker images', description: '查看镜像' },
  { command: 'docker pull', description: '拉取镜像' },
  { command: 'docker push', description: '推送镜像' },
  { command: 'docker build', description: '构建镜像' },
  { command: 'docker build -t', description: '构建并标记' },
  { command: 'docker run', description: '运行容器' },
  { command: 'docker run -d', description: '后台运行' },
  { command: 'docker run -it', description: '交互运行' },
  { command: 'docker run -p', description: '端口映射' },
  { command: 'docker run -v', description: '卷映射' },
  { command: 'docker run --name', description: '指定名称' },
  { command: 'docker exec', description: '执行命令' },
  { command: 'docker exec -it', description: '交互式执行' },
  { command: 'docker stop', description: '停止容器' },
  { command: 'docker start', description: '启动容器' },
  { command: 'docker restart', description: '重启容器' },
  { command: 'docker rm', description: '删除容器' },
  { command: 'docker rm -f', description: '强制删除' },
  { command: 'docker rmi', description: '删除镜像' },
  { command: 'docker logs', description: '查看日志' },
  { command: 'docker logs -f', description: '实时日志' },
  { command: 'docker inspect', description: '查看详情' },
  { command: 'docker stats', description: '资源统计' },
  { command: 'docker network', description: '网络管理' },
  { command: 'docker network ls', description: '列出网络' },
  { command: 'docker volume', description: '卷管理' },
  { command: 'docker volume ls', description: '列出卷' },
  // Docker Compose (旧格式)
  { command: 'docker-compose', description: 'Docker Compose' },
  { command: 'docker-compose up', description: '启动服务' },
  { command: 'docker-compose up -d', description: '后台启动' },
  { command: 'docker-compose up --build', description: '构建并启动' },
  { command: 'docker-compose up -d --build', description: '构建并后台启动' },
  { command: 'docker-compose down', description: '停止服务' },
  { command: 'docker-compose down -v', description: '停止并删除卷' },
  { command: 'docker-compose down --rmi all', description: '停止并删除镜像' },
  { command: 'docker-compose ps', description: '查看状态' },
  { command: 'docker-compose logs', description: '查看日志' },
  { command: 'docker-compose logs -f', description: '实时日志' },
  { command: 'docker-compose logs --tail 100', description: '最近100行日志' },
  { command: 'docker-compose exec', description: '执行命令' },
  { command: 'docker-compose exec -it', description: '交互式执行' },
  { command: 'docker-compose exec bash', description: '进入bash' },
  { command: 'docker-compose exec sh', description: '进入sh' },
  { command: 'docker-compose start', description: '启动服务' },
  { command: 'docker-compose stop', description: '停止服务' },
  { command: 'docker-compose restart', description: '重启服务' },
  { command: 'docker-compose pause', description: '暂停服务' },
  { command: 'docker-compose unpause', description: '恢复服务' },
  { command: 'docker-compose build', description: '构建镜像' },
  { command: 'docker-compose build --no-cache', description: '无缓存构建' },
  { command: 'docker-compose pull', description: '拉取镜像' },
  { command: 'docker-compose push', description: '推送镜像' },
  { command: 'docker-compose config', description: '验证配置' },
  { command: 'docker-compose config -q', description: '静默验证' },
  { command: 'docker-compose version', description: '查看版本' },
  
  // Docker Compose (新格式 - docker compose)
  { command: 'docker compose', description: 'Docker Compose' },
  { command: 'docker compose up', description: '启动服务' },
  { command: 'docker compose up -d', description: '后台启动' },
  { command: 'docker compose up --build', description: '构建并启动' },
  { command: 'docker compose up -d --build', description: '构建并后台启动' },
  { command: 'docker compose down', description: '停止服务' },
  { command: 'docker compose down -v', description: '停止并删除卷' },
  { command: 'docker compose down --rmi all', description: '停止并删除镜像' },
  { command: 'docker compose ps', description: '查看状态' },
  { command: 'docker compose logs', description: '查看日志' },
  { command: 'docker compose logs -f', description: '实时日志' },
  { command: 'docker compose logs --tail 100', description: '最近100行日志' },
  { command: 'docker compose exec', description: '执行命令' },
  { command: 'docker compose exec -it', description: '交互式执行' },
  { command: 'docker compose exec bash', description: '进入bash' },
  { command: 'docker compose exec sh', description: '进入sh' },
  { command: 'docker compose start', description: '启动服务' },
  { command: 'docker compose stop', description: '停止服务' },
  { command: 'docker compose restart', description: '重启服务' },
  { command: 'docker compose pause', description: '暂停服务' },
  { command: 'docker compose unpause', description: '恢复服务' },
  { command: 'docker compose build', description: '构建镜像' },
  { command: 'docker compose build --no-cache', description: '无缓存构建' },
  { command: 'docker compose pull', description: '拉取镜像' },
  { command: 'docker compose push', description: '推送镜像' },
  { command: 'docker compose config', description: '验证配置' },
  { command: 'docker compose config -q', description: '静默验证' },
  { command: 'docker compose version', description: '查看版本' },
  
  // Kubernetes相关
  { command: 'kubectl get pods', description: '查看Pod' },
  { command: 'kubectl get nodes', description: '查看节点' },
  { command: 'kubectl get services', description: '查看服务' },
  { command: 'kubectl get deployments', description: '查看部署' },
  { command: 'kubectl get all', description: '查看所有资源' },
  { command: 'kubectl describe', description: '查看详情' },
  { command: 'kubectl logs', description: '查看日志' },
  { command: 'kubectl logs -f', description: '实时日志' },
  { command: 'kubectl exec', description: '执行命令' },
  { command: 'kubectl exec -it', description: '交互式执行' },
  { command: 'kubectl apply', description: '应用配置' },
  { command: 'kubectl apply -f', description: '应用文件' },
  { command: 'kubectl delete', description: '删除资源' },
  { command: 'kubectl scale', description: '扩容缩容' },
  { command: 'kubectl config', description: '配置管理' },
  { command: 'kubectl config get-contexts', description: '查看上下文' },
  { command: 'kubectl config use-context', description: '切换上下文' },
  
  // 其他常用命令
  { command: 'clear', description: '清屏' },
  { command: 'reset', description: '重置终端' },
  { command: 'script', description: '记录会话' },
  { command: 'scriptreplay', description: '回放会话' },
  { command: 'time', description: '计时' },
  { command: 'timeout', description: '超时执行' },
  { command: 'nohup', description: '后台执行' },
  { command: 'nohup command &', description: '后台执行并输出' },
  { command: 'yes', description: '重复输出' },
  { command: 'sleep', description: '延时' },
  { command: 'wait', description: '等待进程' },
  { command: 'exit', description: '退出' },
  { command: 'logout', description: '登出' },
  { command: 'reboot', description: '重启' },
  { command: 'shutdown', description: '关机' },
  { command: 'shutdown -h now', description: '立即关机' },
  { command: 'shutdown -r now', description: '立即重启' },
  { command: 'poweroff', description: '关机' },
  { command: 'halt', description: '停机' },
  { command: 'sync', description: '同步磁盘' },
  { command: 'lsof', description: '打开的文件' },
  { command: 'lsof -i', description: '网络连接' },
  { command: 'lsof -i :80', description: '80端口连接' },
  { command: 'fuser', description: '文件用户' },
  { command: 'strace', description: '系统调用追踪' },
  { command: 'ltrace', description: '库调用追踪' },
];

interface TerminalProps {
  connectionId: string | null;
  onCommandRequest?: (command: string) => void;
  theme?: 'dark' | 'light' | 'system';
  settings?: AppSettings;
}

// 终端主题配置 - 扩展多个预设
export const TERMINAL_THEMES: Record<string, any> = {
  dark: {
    background: '#020617',
    foreground: '#F8FAFC',
    cursor: '#3B82F6',
    selectionBackground: '#1E40AF',
    black: '#0F172A',
    red: '#EF4444',
    green: '#10B981',
    yellow: '#F59E0B',
    blue: '#3B82F6',
    magenta: '#EC4899',
    cyan: '#06B6D4',
    white: '#CBD5E1',
    brightBlack: '#475569',
    brightRed: '#F87171',
    brightGreen: '#34D399',
    brightYellow: '#FBBF24',
    brightBlue: '#60A5FA',
    brightMagenta: '#F472B6',
    brightCyan: '#22D3EE',
    brightWhite: '#F8FAFC',
  },
  light: {
    background: '#F8FAFC',
    foreground: '#0F172A',
    cursor: '#2563EB',
    selectionBackground: '#DBEAFE',
    black: '#1E293B',
    red: '#DC2626',
    green: '#059669',
    yellow: '#D97706',
    blue: '#2563EB',
    magenta: '#DB2777',
    cyan: '#0891B2',
    white: '#E2E8F0',
    brightBlack: '#64748B',
    brightRed: '#F87171',
    brightGreen: '#34D399',
    brightYellow: '#FBBF24',
    brightBlue: '#3B82F6',
    brightMagenta: '#F472B6',
    brightCyan: '#22D3EE',
    brightWhite: '#0F172A',
  },
  // 额外主题
  monokai: {
    background: '#272822',
    foreground: '#F8F8F2',
    cursor: '#F8F8F0',
    selectionBackground: '#49483E',
    black: '#272822',
    red: '#F92672',
    green: '#A6E22E',
    yellow: '#F4BF75',
    blue: '#66D9EF',
    magenta: '#AE81FF',
    cyan: '#A1EFE4',
    white: '#F8F8F2',
    brightBlack: '#75715E',
    brightRed: '#F92672',
    brightGreen: '#A6E22E',
    brightYellow: '#F4BF75',
    brightBlue: '#66D9EF',
    brightMagenta: '#AE81FF',
    brightCyan: '#A1EFE4',
    brightWhite: '#F9F8F5',
  },
  solarized: {
    background: '#002B36',
    foreground: '#839496',
    cursor: '#839496',
    selectionBackground: '#073642',
    black: '#002B36',
    red: '#DC322F',
    green: '#859900',
    yellow: '#B58900',
    blue: '#268BD2',
    magenta: '#D33682',
    cyan: '#2AA198',
    white: '#EEE8D5',
    brightBlack: '#002B36',
    brightRed: '#CB4B16',
    brightGreen: '#859900',
    brightYellow: '#B58900',
    brightBlue: '#268BD2',
    brightMagenta: '#D33682',
    brightCyan: '#2AA198',
    brightWhite: '#FDF6E3',
  },
  oneDark: {
    background: '#282C34',
    foreground: '#ABB2BF',
    cursor: '#528BFF',
    selectionBackground: '#3E4451',
    black: '#282C34',
    red: '#E06C75',
    green: '#98C379',
    yellow: '#E5C07B',
    blue: '#61AFEF',
    magenta: '#C678DD',
    cyan: '#56B6C2',
    white: '#ABB2BF',
    brightBlack: '#5C6370',
    brightRed: '#E06C75',
    brightGreen: '#98C379',
    brightYellow: '#E5C07B',
    brightBlue: '#61AFEF',
    brightMagenta: '#C678DD',
    brightCyan: '#56B6C2',
    brightWhite: '#FFFFFF',
  },
  nord: {
    background: '#2E3440',
    foreground: '#D8DEE9',
    cursor: '#D8DEE9',
    selectionBackground: '#434C5E',
    black: '#3B4252',
    red: '#BF616A',
    green: '#A3BE8C',
    yellow: '#EBCB8B',
    blue: '#81A1C1',
    magenta: '#B48EAD',
    cyan: '#88C0D0',
    white: '#E5E9F0',
    brightBlack: '#4C566A',
    brightRed: '#BF616A',
    brightGreen: '#A3BE8C',
    brightYellow: '#EBCB8B',
    brightBlue: '#81A1C1',
    brightMagenta: '#B48EAD',
    brightCyan: '#8FBCBB',
    brightWhite: '#ECEFF4',
  },
  dracula: {
    background: '#282A36',
    foreground: '#F8F8F2',
    cursor: '#F8F8F0',
    selectionBackground: '#44475A',
    black: '#282A36',
    red: '#FF5555',
    green: '#50FA7B',
    yellow: '#F1FA8C',
    blue: '#BD93F9',
    magenta: '#FF79C6',
    cyan: '#8BE9FD',
    white: '#F8F8F2',
    brightBlack: '#6272A4',
    brightRed: '#FF6E6E',
    brightGreen: '#69FF94',
    brightYellow: '#FFFFA5',
    brightBlue: '#D6ACFF',
    brightMagenta: '#FF92DF',
    brightCyan: '#A4FFFF',
    brightWhite: '#FFFFFF',
  },
  github: {
    background: '#24292E',
    foreground: '#D1D5DA',
    cursor: '#C8C8C8',
    selectionBackground: '#3392FF44',
    black: '#24292E',
    red: '#F97583',
    green: '#85E89D',
    yellow: '#FFEA7F',
    blue: '#79B8FF',
    magenta: '#B392F0',
    cyan: '#79B8FF',
    white: '#D1D5DA',
    brightBlack: '#636E7B',
    brightRed: '#F97583',
    brightGreen: '#85E89D',
    brightYellow: '#FFEA7F',
    brightBlue: '#79B8FF',
    brightMagenta: '#B392F0',
    brightCyan: '#79B8FF',
    brightWhite: '#FAFBFC',
  },
  ubuntu: {
    background: '#300A24',
    foreground: '#FFFFFF',
    cursor: '#EEEEEC',
    selectionBackground: '#B5D5FF',
    black: '#2E3436',
    red: '#CC0000',
    green: '#4E9A06',
    yellow: '#C4A000',
    blue: '#3465A4',
    magenta: '#75507B',
    cyan: '#06989A',
    white: '#D3D7CF',
    brightBlack: '#555753',
    brightRed: '#EF2929',
    brightGreen: '#8AE234',
    brightYellow: '#FCE94F',
    brightBlue: '#729FCF',
    brightMagenta: '#AD7FA8',
    brightCyan: '#34E2E2',
    brightWhite: '#EEEEEC',
  },
};

// 主题名称映射
const THEME_NAMES: Record<string, string> = {
  dark: '默认暗色',
  light: '默认亮色',
  monokai: 'Monokai',
  solarized: 'Solarized Dark',
  oneDark: 'One Dark',
  nord: 'Nord',
  dracula: 'Dracula',
  github: 'GitHub Dark',
  ubuntu: 'Ubuntu',
};

// 获取当前实际使用的主题（处理 system 主题）
const getEffectiveTheme = (theme: 'dark' | 'light' | 'system'): 'dark' | 'light' => {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return theme;
};

export function Terminal({ connectionId, onCommandRequest, theme: themeProp, settings }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const lastWrittenRef = useRef<string>('');
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [fontSize, setFontSize] = useState(14);
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const [terminalTheme, setTerminalTheme] = useState(settings?.terminalTheme || 'dark');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const initTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fitTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  // 如果没有传入 theme，则使用 useTheme hook
  const { theme: hookTheme } = useTheme();
  const theme = themeProp ?? hookTheme;

  // 自动补全相关状态
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<{ command: string; description: string }[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const currentInputRef = useRef('');

  // 使用 selector 精确订阅当前连接的输出，避免其他连接更新触发重渲染
  const currentTerminalOutput = useConnectionStore(
    useCallback((state) => state.terminalOutputs[connectionId || ''] || '', [connectionId])
  );
  const [commandHistory, setCommandHistory] = useState<CommandHistoryItem[]>([]);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);

  // 直接调用 SSH resize API，不依赖 store 的 activeConnectionId
  const resizeSSH = useCallback((cols: number, rows: number) => {
    if (connectionId && window.electronAPI) {
      window.electronAPI.sshResize(connectionId, cols, rows);
    }
  }, [connectionId]);

  // 加载命令历史和快速命令
  useEffect(() => {
    const loadData = async () => {
      if (window.electronAPI) {
        const [historyResult, quickResult] = await Promise.all([
          window.electronAPI.getCommandHistory(),
          window.electronAPI.getQuickCommands(),
        ]);
        if (historyResult.success) {
          setCommandHistory(Array.isArray(historyResult.data?.history) ? historyResult.data.history : []);
        }
        if (quickResult.success) {
          setQuickCommands(Array.isArray(quickResult.data?.commands) ? quickResult.data.commands : []);
        }
      }
    };
    loadData();
  }, [connectionId]);

  // 获取自动补全建议
  const getSuggestions = useCallback((query: string) => {
    if (!query.trim()) {
      return [];
    }

    const lowerQuery = query.toLowerCase();
    const seen = new Set<string>();
    const suggestions: { command: string; description: string; priority: number }[] = [];

    // 1. 从历史命令匹配（最高优先级）
    if (commandHistory) {
      commandHistory.forEach((item, index) => {
        const cmd = item.command.trim();
        if (!seen.has(cmd)) {
          const startsWith = cmd.toLowerCase().startsWith(lowerQuery);
          const includes = cmd.toLowerCase().includes(lowerQuery);
          
          if (startsWith || includes) {
            seen.add(cmd);
            suggestions.push({
              command: cmd,
              description: `历史命令`,
              priority: startsWith ? 100 - index : 50 - index, // 最近使用的历史命令优先级更高
            });
          }
        }
      });
    }

    // 2. 从快速命令匹配（高优先级）
    if (quickCommands) {
      quickCommands.forEach((cmd, index) => {
        if (!seen.has(cmd.command)) {
          const startsWithCmd = cmd.command.toLowerCase().startsWith(lowerQuery);
          const includesName = cmd.name.toLowerCase().includes(lowerQuery);
          
          if (startsWithCmd || includesName) {
            seen.add(cmd.command);
            suggestions.push({
              command: cmd.command,
              description: cmd.description || '快速命令',
              priority: startsWithCmd ? 80 : 40,
            });
          }
        }
      });
    }

    // 3. 从常用命令匹配（标准优先级）
    COMMON_COMMANDS.forEach((cmd, index) => {
      if (!seen.has(cmd.command)) {
        const startsWith = cmd.command.toLowerCase().startsWith(lowerQuery);
        const includes = cmd.command.toLowerCase().includes(lowerQuery) || 
                        cmd.description.toLowerCase().includes(lowerQuery);
        
        if (startsWith || includes) {
          seen.add(cmd.command);
          suggestions.push({
            command: cmd.command,
            description: cmd.description,
            priority: startsWith ? 60 : 20,
          });
        }
      }
    });

    // 按优先级排序，然后返回前10个
    return suggestions
      .sort((a, b) => b.priority - a.priority)
      .slice(0, 10)
      .map(({ command, description }) => ({ command, description }));
  }, [commandHistory, quickCommands]);

  // 自动补全命令到输入框
  const applyAutocomplete = useCallback((command: string) => {
    if (!xtermRef.current) {
      setShowAutocomplete(false);
      return;
    }

    const term = xtermRef.current;
    const currentInput = currentInputRef.current;

    // 1. 先删除当前输入的字符（发送退格键到 SSH）
    for (let i = 0; i < currentInput.length; i++) {
      if (connectionId && window.electronAPI) {
        window.electronAPI.sshExecuteSync(connectionId, '\x7f');
      }
    }

    // 2. 发送补全命令字符到 SSH
    if (connectionId && window.electronAPI) {
      window.electronAPI.sshExecuteSync(connectionId, command);
    }

    // 3. 更新当前输入引用
    currentInputRef.current = command;

    // 4. 关闭补全提示
    setShowAutocomplete(false);
  }, [connectionId]);

  // 终端右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    if (!connectionId) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const handleCopy = () => {
    if (xtermRef.current) {
      const selection = xtermRef.current.getSelection();
      if (selection) {
        navigator.clipboard.writeText(selection);
      }
    }
    closeContextMenu();
  };

  const handlePaste = () => {
    if (xtermRef.current) {
      navigator.clipboard.readText().then(text => {
        if (text) {
          xtermRef.current?.paste(text);
        }
      });
    }
    closeContextMenu();
  };

  const handlePasteToInput = () => {
    if (!xtermRef.current) {
      closeContextMenu();
      return;
    }

    // 优先获取终端的选中文本，如果没有再尝试从剪贴板读取
    let text = xtermRef.current.getSelection();

    if (text && text.trim()) {
      // 使用终端选中的文本
      pasteToInput(text);
      closeContextMenu();
    } else {
      // 如果终端没有选中文本，尝试从剪贴板读取
      navigator.clipboard.readText().then(clipboardText => {
        if (clipboardText) {
          pasteToInput(clipboardText);
        }
        closeContextMenu();
      }).catch(err => {
        console.error('Failed to read clipboard:', err);
        closeContextMenu();
      });
    }
  };

  // 辅助函数：处理粘贴到输入栏
  const pasteToInput = (text: string) => {
    if (!xtermRef.current) return;

    // 去掉末尾的换行符，只粘贴到输入栏不自动执行
    const cleanText = text.replace(/[\r\n]+$/, '');

    if (cleanText) {
      // 使用 paste 方法，这会正确地将文本发送到终端并触发 onData 事件
      xtermRef.current.paste(cleanText);
    }
  };

  // 合并的全局键盘监听 - 处理自动补全、搜索、字体等
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 自动补全导航
      if (showAutocomplete) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          setAutocompleteIndex(prev => Math.min(prev + 1, autocompleteSuggestions.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setAutocompleteIndex(prev => Math.max(prev - 1, 0));
          return;
        }
        if (e.ctrlKey && (e.key === 'e' || e.key === 'E')) {
          e.preventDefault();
          e.stopPropagation();
          if (autocompleteSuggestions.length > 0) {
            applyAutocomplete(autocompleteSuggestions[autocompleteIndex].command);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setShowAutocomplete(false);
          return;
        }
      }

      // 搜索和字体快捷键
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setFontSize(prev => Math.min(prev + 2, 24));
      }
      if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        setFontSize(prev => Math.max(prev - 2, 10));
      }
      if (e.key === 'Escape' && showSearch) {
        setShowSearch(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [showAutocomplete, autocompleteIndex, autocompleteSuggestions, showSearch, applyAutocomplete]);

  // 当 settings 中的 terminalTheme 变化时同步本地状态（处理异步加载）
  useEffect(() => {
    if (settings?.terminalTheme && settings.terminalTheme !== terminalTheme) {
      setTerminalTheme(settings.terminalTheme);
    }
  }, [settings?.terminalTheme]);

  // 更新终端主题
  const updateTerminalTheme = useCallback(() => {
    if (xtermRef.current && TERMINAL_THEMES[terminalTheme]) {
      xtermRef.current.options.theme = TERMINAL_THEMES[terminalTheme];
    }
  }, [terminalTheme]);

  // 切换主题
  const handleThemeChange = async (newTheme: string) => {
    setTerminalTheme(newTheme);
    if (xtermRef.current && TERMINAL_THEMES[newTheme]) {
      xtermRef.current.options.theme = TERMINAL_THEMES[newTheme];
    }
    setShowThemeSelector(false);

    // 持久化终端主题选择
    if (settings && window.electronAPI) {
      try {
        const newSettings = { ...settings, terminalTheme: newTheme };
        await window.electronAPI.saveSettings(newSettings);
      } catch (error) {
        console.error('Failed to save terminal theme:', error);
      }
    }
  };

  // 初始化/清理 xterm
  useEffect(() => {
    if (!connectionId || !terminalRef.current) {
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      return;
    }

    if (xtermRef.current) {
      return;
    }

    const term = new XTerm({
      theme: TERMINAL_THEMES[terminalTheme],
      fontFamily: 'JetBrains Mono, Source Code Pro, Consolas, monospace',
      fontSize: fontSize,
      lineHeight: 1.4,
      cursorBlink: true,
      allowTransparency: true,
      // 确保光标可见
      cursorStyle: 'block',
      // 滚动条配置
      overviewRulerWidth: 12,
    });

    // 确保 xterm 不会在本地处理某些转义序列
    term.options.scrollback = 10000;

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);

    term.open(terminalRef.current);
    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // 拦截 xterm 内部对 Ctrl+F 的处理，交还给我们的全局快捷键
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'f') {
        return false; // 阻止 xterm 处理，事件冒泡到 window
      }
      return true; // 其他按键正常处理
    });

    // 初始化终端尺寸（等待容器完全渲染）
    initTimeoutRef.current = setTimeout(() => {
      requestAnimationFrame(() => {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = xtermRef.current;
          resizeSSH(cols, rows);
          xtermRef.current.refresh(0, xtermRef.current.rows - 1);
        }
      });

      // 再次延迟 fit 一次，确保 xterm 内部状态正确
      fitTimeoutRef.current = setTimeout(() => {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = xtermRef.current;
          resizeSSH(cols, rows);
        }
      }, 200);
    }, 100);

    // 窗口 resize 时处理
    const handleWindowResize = () => {
      if (xtermRef.current && fitAddonRef.current && connectionId && terminalRef.current) {
        fitAddonRef.current.fit();
        const { cols, rows } = xtermRef.current;
        if (cols > 0 && rows > 0) {
          resizeSSH(cols, rows);
        }
      }
    };
    window.addEventListener('resize', handleWindowResize);

    term.clear();
    term.write('\x1b[1;32m=== SSH 连接成功 ===\x1b[0m\r\n');
    term.write('\x1b[1;33m等待服务器响应...\x1b[0m\r\n\r\n');
    lastWrittenRef.current = '';
    currentInputRef.current = '';

    // 设置 ResizeObserver 监听容器尺寸变化 - 添加防抖避免频繁触发
    resizeObserverRef.current = new ResizeObserver(() => {
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      resizeTimeoutRef.current = setTimeout(() => {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          const { cols, rows } = xtermRef.current;
          if (cols > 0 && rows > 0) {
            resizeSSH(cols, rows);
          }
        }
      }, 100);
    });
    
    if (terminalRef.current) {
      resizeObserverRef.current.observe(terminalRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleWindowResize);
      if (initTimeoutRef.current) {
        clearTimeout(initTimeoutRef.current);
        initTimeoutRef.current = null;
      }
      if (fitTimeoutRef.current) {
        clearTimeout(fitTimeoutRef.current);
        fitTimeoutRef.current = null;
      }
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect();
        resizeObserverRef.current = null;
      }
      term.dispose();
      xtermRef.current = null;
    };
  }, [connectionId, resizeSSH]);

  // 将命令写入终端（用于从 AI 复制命令到终端输入）
  useEffect(() => {
    (window as any).writeToTerminal = (cmd: string) => {
      if (xtermRef.current) {
        // 使用 paste 将文本插入终端，这会触发 onData 并发送到 SSH
        xtermRef.current.paste(cmd);
      }
    };
    return () => {
      delete (window as any).writeToTerminal;
    };
  }, []);



  // 处理字体大小变化
  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.options.fontSize = fontSize;
      fitAddonRef.current?.fit();
      // 字体变化后同步服务器端终端尺寸
      const { cols, rows } = xtermRef.current;
      resizeSSH(cols, rows);
    }
  }, [fontSize, resizeSSH]);

  // 监听 xterm 输入 - 简单、稳定的方式
  useEffect(() => {
    if (!xtermRef.current || !connectionId) {
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
      return;
    }

    if (onDataDisposableRef.current) {
      return;
    }

    const term = xtermRef.current;

    const onDataDisposable = term.onData((data: string) => {
      // 直接发送到 SSH - 使用同步 IPC 发送，不等待返回值
      if (connectionId && window.electronAPI) {
        window.electronAPI.sshExecuteSync(connectionId, data);
      }

      // 跟踪当前输入，仅用于显示补全
      if (data === '\r') {
        // Enter - 保存命令到历史
        const cmd = currentInputRef.current.trim();
        if (cmd) {
          (async () => {
            if (window.electronAPI) {
              const { connections, activeConnectionId } = useConnectionStore.getState();
              const connection = connections.find(c => c.id === activeConnectionId);
              const historyItem: CommandHistoryItem = {
                id: Date.now().toString(),
                command: cmd,
                timestamp: Date.now(),
                connectionId: activeConnectionId || '',
                connectionName: connection?.name || 'Unknown',
                executedBy: 'terminal',
                approved: true,
              };
              await window.electronAPI.addCommandHistory(historyItem);
              // 刷新历史命令
              const historyResult = await window.electronAPI.getCommandHistory();
              if (historyResult.success) {
                setCommandHistory(historyResult.history);
              }
            }
          })();
        }
        currentInputRef.current = '';
        setShowAutocomplete(false);
      } else if (data === '\x7f') {
        // Backspace
        currentInputRef.current = currentInputRef.current.slice(0, -1);
      } else if (data === '\x03') {
        // Ctrl+C
        currentInputRef.current = '';
        setShowAutocomplete(false);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // 普通字符输入
        currentInputRef.current += data;
      }

      // 检查补全
      if (currentInputRef.current.length > 0) {
        const suggestions = getSuggestions(currentInputRef.current);
        setAutocompleteSuggestions(suggestions);
        if (suggestions.length > 0) {
          setShowAutocomplete(true);
          setAutocompleteIndex(0);
        } else {
          setShowAutocomplete(false);
        }
      } else {
        setShowAutocomplete(false);
      }
    });

    onDataDisposableRef.current = onDataDisposable;

    return () => {
      if (onDataDisposableRef.current) {
        onDataDisposableRef.current.dispose();
        onDataDisposableRef.current = null;
      }
    };
  }, [connectionId, getSuggestions]);

  // 直接写入 terminalOutput
  useEffect(() => {
    if (!xtermRef.current || !connectionId) return;

    const term = xtermRef.current;
    const currentOutput = currentTerminalOutput;

    if (currentOutput.length > lastWrittenRef.current.length) {
      // 正常情况：有新数据
      const newData = currentOutput.slice(lastWrittenRef.current.length);
      if (newData) {
        term.write(newData);
        lastWrittenRef.current = currentOutput;
      }
    } else if (currentOutput.length < lastWrittenRef.current.length) {
      // 输出被截断了（达到大小限制），重置引用避免索引错乱
      lastWrittenRef.current = currentOutput;
    }
  }, [currentTerminalOutput, connectionId]);

  // 监听主题变化并更新终端
  useEffect(() => {
    updateTerminalTheme();
  }, [updateTerminalTheme]);

  // 监听系统主题变化（当 theme 为 'system' 时）
  useEffect(() => {
    if (theme !== 'system') return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => {
      updateTerminalTheme();
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme, updateTerminalTheme]);

  // 搜索功能
  useEffect(() => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  }, [searchQuery]);

  const handleSearchNext = () => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findNext(searchQuery);
    }
  };

  const handleSearchPrev = () => {
    if (searchAddonRef.current && searchQuery) {
      searchAddonRef.current.findPrevious(searchQuery);
    }
  };

  return (
    <div
      className={`flex-1 relative bg-slate-100 dark:bg-slate-950`}
      onContextMenu={handleContextMenu}
    >
      {/* Terminal Toolbar */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
        <button
          onClick={() => setFontSize(prev => Math.max(prev - 2, 10))}
          className="p-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
          title="缩小 (Ctrl+-)"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-xs text-slate-500 dark:text-slate-400 px-1">{fontSize}px</span>
        <button
          onClick={() => setFontSize(prev => Math.min(prev + 2, 24))}
          className="p-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
          title="放大 (Ctrl++)"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={() => setShowSearch(prev => !prev)}
          className={`p-1.5 rounded transition-colors ${
            showSearch ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
          }`}
          title="搜索 (Ctrl+F)"
        >
          <Search className="w-4 h-4" />
        </button>

        {/* 主题选择器 */}
        <div className="relative">
          <button
            onClick={() => setShowThemeSelector(prev => !prev)}
            className="p-1.5 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 rounded text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
            title="切换主题"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
            </svg>
          </button>

          {showThemeSelector && (
            <div className="absolute right-0 top-full mt-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg py-1 min-w-[160px] z-20">
              {Object.keys(TERMINAL_THEMES).map(themeKey => (
                <button
                  key={themeKey}
                  onClick={() => handleThemeChange(themeKey)}
                  className={`w-full px-3 py-1.5 text-left text-sm transition-colors ${
                    terminalTheme === themeKey
                      ? 'bg-blue-500 text-white'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-4 h-4 rounded border border-slate-300 dark:border-slate-600"
                      style={{ background: TERMINAL_THEMES[themeKey].background }}
                    />
                    {THEME_NAMES[themeKey]}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Search Bar */}
      {showSearch && (
        <div className="absolute top-2 left-2 z-10 flex items-center gap-2 bg-white dark:bg-slate-800 rounded-lg p-2 shadow-lg border border-slate-200 dark:border-slate-700">
          <Search className="w-4 h-4 text-slate-500 dark:text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.shiftKey ? handleSearchPrev() : handleSearchNext();
              }
            }}
            placeholder="搜索..."
            className="bg-transparent border-none outline-none text-sm text-slate-900 dark:text-white w-48"
            autoFocus
          />
          <button onClick={handleSearchPrev} className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white">
            ↑
          </button>
          <button onClick={handleSearchNext} className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white">
            ↓
          </button>
          <button onClick={() => { setShowSearch(false); setSearchQuery(''); }} className="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white">
            ✕
          </button>
        </div>
      )}

      {/* 自动补全提示 - 输入时自动展示 */}
      {settings?.showTerminalOutputPrompt !== false && showAutocomplete && autocompleteSuggestions.length > 0 && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden min-w-[300px] max-w-[500px]">
          <div className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900">
            输入时自动补全 - ↑↓ 选择 / Ctrl+E 应用 / Esc 关闭
          </div>
          {autocompleteSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.command}
              onClick={(e) => { e.stopPropagation(); applyAutocomplete(suggestion.command); }}
              className={`w-full px-3 py-2 text-left flex items-center gap-3 transition-colors ${
                index === autocompleteIndex
                  ? 'bg-blue-500 text-white'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300'
              }`}
            >
              <TerminalIcon className={`w-4 h-4 flex-shrink-0 ${
                index === autocompleteIndex ? 'text-blue-200' : 'text-blue-500'
              }`} />
              <code className="flex-1 font-mono text-sm truncate">{suggestion.command}</code>
              <span className={`text-xs ${
                index === autocompleteIndex ? 'text-blue-200' : 'text-slate-400'
              }`}>{suggestion.description}</span>
            </button>
          ))}
        </div>
      )}

      {/* Terminal Container */}
      <div 
        ref={terminalRef} 
        className="absolute inset-0 pr-1 pl-2 pt-2 pb-2"
        style={{
          cursor: 'text'
        }}
      />

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onPasteToInput={handlePasteToInput}
          onClose={closeContextMenu}
        />
      )}

      {/* No Connection State */}
      {!connectionId && (
        <div className="absolute inset-0 flex items-center justify-center text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-950">
          <div className="text-center">
            <div className="text-4xl mb-4">🐚</div>
            <p className="text-sm text-slate-600 dark:text-slate-400">选择一个连接并点击"连接"开始</p>
          </div>
        </div>
      )}
    </div>
  );
}
