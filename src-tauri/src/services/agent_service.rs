use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::error::{app_error, AppResult};
use crate::services::sentinel::{
    format_agent_command_echo, make_sentinel_marker, parse_sentinel,
    strip_complete_sentinel_artifacts, wrap_command_with_sentinel, SentinelStripper,
};
use crate::services::ssh_service::SshService;

// 默认命令执行超时时间（20 分钟）
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 20 * 60 * 1000;
const INTERRUPT_SETTLE_MS: u64 = 250;
// 输出缓冲区最大大小（1MB）
const MAX_BUFFER_SIZE: usize = 1024 * 1024;
// 缓冲区保留大小（当超过最大值时保留的尾部大小，768KB）
const KEEP_BUFFER_SIZE: usize = 768 * 1024;

/// 裁剪超限的执行缓冲区。
///
/// 历史缺陷：旧实现直接 `buffer[len - KEEP_BUFFER_SIZE..]`，一是**按字节切开 String**，
/// 切点落在多字节字符中间会 panic；二是可能把哨兵行切成两半，`parse_sentinel` 之后
/// 永远匹配不到，命令静默退化成「提示符启发式」并丢掉退出码。
/// 现在先对齐 UTF-8 边界，再对齐到行首。
fn trim_exec_buffer(buffer: &mut String) {
    if buffer.len() <= MAX_BUFFER_SIZE {
        return;
    }

    let target = buffer.len() - KEEP_BUFFER_SIZE;
    let mut cut = target.min(buffer.len());
    while cut < buffer.len() && !buffer.is_char_boundary(cut) {
        cut += 1;
    }

    if let Some(aligned) = buffer[cut..].find('\n').map(|offset| cut + offset + 1) {
        if aligned < buffer.len() {
            cut = aligned;
        }
    }

    *buffer = buffer[cut..].to_string();
}

/// Agent 服务 - 提供终端输出转发和基于 Sentinel 标记的命令执行功能
///
/// 该服务用于 AI Agent 执行命令时的输出捕获和命令完成检测。
/// 通过在命令末尾添加 Sentinel 标记来检测命令是否执行完成。
pub struct AgentService {
    /// 活跃的 Agent 任务句柄映射（连接ID -> 任务句柄）
    tasks: Arc<Mutex<HashMap<String, AgentTaskHandle>>>,
    /// 待执行的命令句柄映射（连接ID -> 执行句柄）
    pending_execs: Arc<Mutex<HashMap<String, PendingExecHandle>>>,
}

/// Agent 任务句柄 - 用于取消任务
struct AgentTaskHandle {
    /// 取消信号发送器
    cancel: oneshot::Sender<()>,
}

/// 待执行命令句柄 - 用于取消命令执行
struct PendingExecHandle {
    /// 取消信号发送器
    cancel: oneshot::Sender<()>,
    /// 产生该句柄的 run_id：注销时用它做身份校验，
    /// 避免先完成的执行把**别人**的句柄删掉（旧实现的按键无条件删除）。
    run_id: String,
}

/// Agent 命令执行结果
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExecAwaitResult {
    /// 命令输出内容
    pub output: String,
    /// 命令退出码（如果可获取）
    pub exit_code: Option<i32>,
    /// 完成原因：done（正常完成）、timeout（超时）、canceled（取消）、closed（连接关闭）
    pub reason: String,
}

impl AgentService {
    /// 创建新的 Agent 服务实例
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            pending_execs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 启动 Agent 任务，开始转发终端输出到前端
    ///
    /// 该方法会订阅 SSH 连接的终端输出，并过滤掉 Sentinel 标记后转发给前端。
    ///
    /// # 参数
    /// * `app_handle` - Tauri 应用句柄，用于发送事件
    /// * `ssh` - SSH 服务实例
    /// * `task_id` - 任务 ID
    /// * `connection_id` - SSH 连接 ID
    pub fn start_task(
        &self,
        app_handle: AppHandle,
        ssh: &SshService,
        task_id: String,
        connection_id: String,
    ) -> AppResult<()> {
        self.stop_task(&connection_id).ok();

        let mut output_rx = ssh.subscribe_output(&connection_id)?;
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        self.tasks
            .lock()
            .map_err(|_| app_error("Agent 状态锁已损坏"))?
            .insert(connection_id.clone(), AgentTaskHandle { cancel: cancel_tx });

        let tasks = Arc::clone(&self.tasks);
        let task_connection_id = connection_id.clone();
        tauri::async_runtime::spawn(async move {
            let mut stripper = SentinelStripper::default();
            loop {
                tokio::select! {
                    data = output_rx.recv() => {
                        let Some(data) = data else {
                            break;
                        };
                        let clean = stripper.feed(&data);
                        if !clean.is_empty() {
                            let _ = app_handle.emit(
                                "agent-terminal-output",
                                json!({
                                    "connectionId": task_connection_id,
                                    "taskId": task_id,
                                    "data": clean,
                                }),
                            );
                        }
                    }
                    _ = &mut cancel_rx => {
                        break;
                    }
                }
            }

            let tail = stripper.flush();
            if !tail.is_empty() {
                let _ = app_handle.emit(
                    "agent-terminal-output",
                    json!({
                        "connectionId": task_connection_id,
                        "taskId": task_id,
                        "data": tail,
                    }),
                );
            }

            if let Ok(mut guard) = tasks.lock() {
                guard.remove(&task_connection_id);
            }
        });

        Ok(())
    }

    /// 停止 Agent 任务，停止输出转发并取消待执行的命令
    ///
    /// # 参数
    /// * `connection_id` - SSH 连接 ID
    pub fn stop_task(&self, connection_id: &str) -> AppResult<()> {
        if let Some(task) = self
            .tasks
            .lock()
            .map_err(|_| app_error("Agent 状态锁已损坏"))?
            .remove(connection_id)
        {
            let _ = task.cancel.send(());
        }

        self.cancel_exec(connection_id).ok();
        Ok(())
    }

    /// 执行命令并等待完成（通过 Sentinel 标记检测）
    ///
    /// 该方法会在命令末尾添加 Sentinel 标记，然后等待该标记出现在输出中。
    /// 支持超时、取消等操作。
    ///
    /// # 参数
    /// * `app_handle` - Tauri 应用句柄
    /// * `ssh` - SSH 服务实例
    /// * `connection_id` - SSH 连接 ID
    /// * `command` - 要执行的命令
    /// * `run_id` - 运行 ID（用于生成唯一的 Sentinel 标记）
    /// * `timeout_ms` - 超时时间（毫秒）
    ///
    /// # 返回
    /// 返回命令执行结果，包含输出、退出码和完成原因
    pub async fn exec_await(
        &self,
        app_handle: AppHandle,
        ssh: &SshService,
        connection_id: String,
        command: String,
        run_id: String,
        timeout_ms: u64,
    ) -> AppResult<AgentExecAwaitResult> {
        check_command_guard(&command)?;

        let mut output_rx = ssh.subscribe_output(&connection_id)?;
        let (cancel_tx, mut cancel_rx) = oneshot::channel();

        // 注册句柄必须在**同一次加锁**内完成「取旧 + 插新」：
        // 旧实现先 contains_key 再单独 insert（两次加锁），并发执行会互相覆盖句柄，
        // 落败的那条命令再也无法取消，只能等满超时。现在把被顶替的旧句柄取出来并丢弃
        // —— 其 oneshot Sender 被 drop 后，旧执行的 cancel_rx 立即就绪，会自行 Ctrl-C 收尾。
        let superseded = {
            let mut pending = self
                .pending_execs
                .lock()
                .map_err(|_| app_error("Agent 执行状态锁已损坏"))?;
            let superseded = pending.insert(
                connection_id.clone(),
                PendingExecHandle {
                    cancel: cancel_tx,
                    run_id: run_id.clone(),
                },
            );
            superseded
        };
        drop(superseded);

        ssh.emit_terminal_data(
            &app_handle,
            &connection_id,
            format_agent_command_echo(&command),
        );
        ssh.execute(
            &connection_id,
            wrap_command_with_sentinel(&command, &run_id),
        )?;

        let marker = make_sentinel_marker(&run_id);
        let timeout = tokio::time::sleep(Duration::from_millis(timeout_ms.max(1000)));
        tokio::pin!(timeout);
        let mut prompt_check = tokio::time::interval(Duration::from_millis(300));
        let prompt_grace = Duration::from_millis(1200);
        let mut prompt_seen_at: Option<Instant> = None;
        let mut buffer = String::new();

        let result = loop {
            tokio::select! {
                data = output_rx.recv() => {
                    let Some(data) = data else {
                        // 连接断开：不要丢弃已捕获的输出（旧实现返回空串，前端只能报
                        // 「连接已断开」，用户和模型都看不到命令做了什么）。
                        break AgentExecAwaitResult {
                            output: strip_complete_sentinel_artifacts(&buffer),
                            exit_code: None,
                            reason: "closed".to_string(),
                        };
                    };
                    buffer.push_str(&data);
                    trim_exec_buffer(&mut buffer);
                    if let Some((output, exit_code)) = parse_sentinel(&buffer, &marker) {
                        break AgentExecAwaitResult {
                            output,
                            exit_code: Some(exit_code),
                            reason: "done".to_string(),
                        };
                    }
                    if has_shell_prompt_tail(&buffer) {
                        prompt_seen_at.get_or_insert_with(Instant::now);
                    } else {
                        prompt_seen_at = None;
                    }
                }
                _ = prompt_check.tick() => {
                    if prompt_seen_at
                        .map(|seen_at| seen_at.elapsed() >= prompt_grace)
                        .unwrap_or(false)
                    {
                        break AgentExecAwaitResult {
                            output: strip_complete_sentinel_artifacts(&buffer),
                            exit_code: None,
                            reason: "done".to_string(),
                        };
                    }
                }
                _ = &mut cancel_rx => {
                    let _ = ssh.execute(&connection_id, "\u{3}".to_string());
                    tokio::time::sleep(Duration::from_millis(INTERRUPT_SETTLE_MS)).await;
                    // 必须剥离哨兵包装：否则 `\r(cmd); printf '...__AGENT_DONE_x__...'`
                    // 会作为「命令输出」进入模型上下文。Node 端每条出口都剥离。
                    break AgentExecAwaitResult {
                        output: strip_complete_sentinel_artifacts(&buffer),
                        exit_code: None,
                        reason: "canceled".to_string(),
                    };
                }
                _ = &mut timeout => {
                    let _ = ssh.execute(&connection_id, "\u{3}".to_string());
                    tokio::time::sleep(Duration::from_millis(INTERRUPT_SETTLE_MS)).await;
                    break AgentExecAwaitResult {
                        output: strip_complete_sentinel_artifacts(&buffer),
                        exit_code: None,
                        reason: "timeout".to_string(),
                    };
                }
            }
        };

        self.unregister_exec(&connection_id, &run_id);
        Ok(result)
    }

    /// 取消待执行的命令
    ///
    /// # 参数
    /// * `connection_id` - SSH 连接 ID
    ///
    /// # 返回
    /// 返回是否成功取消（true 表示有命令被取消）
    pub fn cancel_exec(&self, connection_id: &str) -> AppResult<bool> {
        let mut pending_execs = self
            .pending_execs
            .lock()
            .map_err(|_| app_error("Agent 执行状态锁已损坏"))?;

        Ok(pending_execs
            .remove(connection_id)
            .map(|pending| pending.cancel.send(()).is_ok())
            .unwrap_or(false))
    }

    /// 取消所有待执行的命令
    ///
    /// # 返回
    /// 返回被取消的命令数量
    pub fn cancel_all_execs(&self) -> AppResult<usize> {
        let pending_execs = self
            .pending_execs
            .lock()
            .map_err(|_| app_error("Agent 执行状态锁已损坏"))?
            .drain()
            .map(|(_, pending)| pending)
            .collect::<Vec<_>>();

        let canceled = pending_execs
            .into_iter()
            .map(|pending| usize::from(pending.cancel.send(()).is_ok()))
            .sum();

        Ok(canceled)
    }

    /// 从待执行列表中移除命令（内部方法）
    ///
    /// 只有当前登记的 run_id 和自己一致时才删除：否则「后发起的执行」的句柄会被
    /// 「先完成的执行」误删，导致前者再也无法被暂停/取消。
    fn unregister_exec(&self, connection_id: &str, run_id: &str) {
        if let Ok(mut guard) = self.pending_execs.lock() {
            let owned_by_caller = guard
                .get(connection_id)
                .map(|pending| pending.run_id == run_id)
                .unwrap_or(false);
            if owned_by_caller {
                guard.remove(connection_id);
            }
        }
    }
}

impl Default for AgentService {
    fn default() -> Self {
        Self::new()
    }
}

/// 检查输出缓冲区末尾是否包含 Shell 提示符
///
/// 用于检测命令是否已经执行完成（Shell 已返回提示符）
///
/// # 参数
/// * `buffer` - 输出缓冲区
///
/// # 返回
/// 如果末尾包含 Shell 提示符返回 true，否则返回 false
fn has_shell_prompt_tail(buffer: &str) -> bool {
    let normalized = strip_terminal_control_sequences(tail_text(buffer, 4096)).replace('\r', "\n");
    let tail_has_prompt_line = normalized
        .lines()
        .rev()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(8)
        .any(is_shell_prompt_line);

    tail_has_prompt_line || is_shell_prompt_line(normalized.trim())
}

/// 获取字符串的尾部文本（最多 max_bytes 字节）
///
/// 注意：会在 UTF-8 字符边界处截断，确保返回有效的字符串
///
/// # 参数
/// * `input` - 输入字符串
/// * `max_bytes` - 最大字节数
///
/// # 返回
/// 返回字符串的尾部
fn tail_text(input: &str, max_bytes: usize) -> &str {
    if input.len() <= max_bytes {
        return input;
    }

    let start = input.len() - max_bytes;
    let safe_start = input
        .char_indices()
        .map(|(index, _)| index)
        .find(|index| *index >= start)
        .unwrap_or(0);
    &input[safe_start..]
}

/// 移除终端控制序列（ANSI 转义码等）
///
/// 移除颜色、光标移动等控制字符，保留可读文本
///
/// # 参数
/// * `input` - 原始终端输出
///
/// # 返回
/// 返回清理后的文本
fn strip_terminal_control_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some(']') => {
                    chars.next();
                    let mut previous_escape = false;
                    for osc_char in chars.by_ref() {
                        if osc_char == '\u{7}' || (previous_escape && osc_char == '\\') {
                            break;
                        }
                        previous_escape = osc_char == '\u{1b}';
                    }
                }
                Some('[') => {
                    chars.next();
                    for csi_char in chars.by_ref() {
                        if ('@'..='~').contains(&csi_char) {
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }

        if ch == '\0' || (ch.is_control() && !matches!(ch, '\r' | '\n' | '\t')) {
            continue;
        }

        output.push(ch);
    }

    output
}

/// 判断一行文本是否为 Shell 提示符行
///
/// 通过检测常见的 Shell 提示符模式（如 `user@host:~$` 等）
///
/// # 参数
/// * `line` - 要检查的文本行
///
/// # 返回
/// 如果是 Shell 提示符行返回 true，否则返回 false
fn is_shell_prompt_line(line: &str) -> bool {
    let trimmed = line.trim_end();
    let Some(last) = trimmed.chars().last() else {
        return false;
    };
    if last != '#' && last != '$' {
        return false;
    }

    let suffix = tail_text(trimmed, 180);
    suffix.contains(']') && suffix.contains('[')
        || suffix.contains('@') && suffix.contains(':')
        || suffix.ends_with("~]#")
        || suffix.ends_with("~]$")
        || suffix.ends_with("/#")
        || suffix.ends_with("/$")
        || suffix.contains("bash-")
        || suffix.contains("sh-")
}

/// 本地安全策略：命令执行前的最后一道硬闸门（渲染进程审批之外的纵深防御）。
///
/// 与渲染进程的 `analyze-command-risk.ts` 保持同一套判定形态：按 `;` / `&&` / `||` / `|` /
/// 换行切段，跳过 `sudo` / `env` / `VAR=value` 等前缀后取真正的命令名，再按首词与参数判定。
///
/// 历史缺陷：旧实现用 8 个裸子串 `contains`，既漏（`rm -fr /`、`halt`、`dd of=/dev/sda`）
/// 又误伤（`grep -i shutdown /var/log/syslog` 直接被拒）。
///
/// 被拦截时返回带 `AGENT_POLICY_BLOCKED` 标记的错误；前端据此把它转成给模型的
/// 可自纠观察（换一种做法），而不是把整个任务判死。
fn check_command_guard(command: &str) -> AppResult<()> {
    match find_blocked_reason(command) {
        Some(reason) => Err(app_error(&format!("AGENT_POLICY_BLOCKED: {reason}"))),
        None => Ok(()),
    }
}

/// 首词出现即拒绝：格式化 / 清盘 / 关机类，几乎不存在安全用法。
const BLOCKED_COMMAND_HEADS: [&str; 11] = [
    "wipefs", "blkdiscard", "fdisk", "sfdisk", "parted", "shutdown", "reboot",
    "poweroff", "halt", "telinit", "swapoff",
];

/// 递归删除时必须拒绝的精确目标（已小写）。
const FATAL_RM_TARGETS: [&str; 13] = [
    "/", "/*", "/etc", "/boot", "/usr", "/var", "/home", "/root", "/bin", "/sbin",
    "/lib", "~", "$home",
];

/// 递归删除时按前缀拒绝的根目录：`/usr/lib`、`/etc/nginx` 之类同样不可逆。
///
/// 只放「操作系统本体」目录：`/var`、`/home` 这类数据目录仅在精确匹配时硬拦，
/// 其子路径由渲染进程按 critical 审批（用户明确批准后才执行），
/// 否则连 `rm -rf /var/tmp/cache` 这种日常清理都会被永久禁止。
const FATAL_RM_ROOTS: [&str; 8] = [
    "/etc", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/root",
];

/// 递归删除目标是否命中关键路径（精确匹配或位于关键根目录之下）。
fn is_fatal_rm_target(target: &str) -> bool {
    let normalized = normalize_rm_target(target);
    if FATAL_RM_TARGETS.contains(&normalized.as_str()) {
        return true;
    }
    FATAL_RM_ROOTS
        .iter()
        .any(|root| normalized == *root || normalized.starts_with(&format!("{root}/")))
}

fn find_blocked_reason(command: &str) -> Option<String> {
    let normalized = command.to_lowercase();

    // 整串形态：fork 炸弹与直接覆写块设备
    if normalized.contains(":(){") || normalized.contains(":|:&") {
        return Some("fork 炸弹".to_string());
    }
    if normalized.contains("> /dev/sd") || normalized.contains(">/dev/sd")
        || normalized.contains("> /dev/nvme") || normalized.contains(">/dev/nvme")
    {
        return Some("重定向覆写块设备".to_string());
    }

    for segment in split_command_segments(command) {
        let Some((head, args)) = segment_head_and_args(&segment) else {
            continue;
        };

        if head.starts_with("mkfs") || BLOCKED_COMMAND_HEADS.contains(&head.as_str()) {
            return Some(format!("{head} 属于不可逆的系统级操作"));
        }

        match head.as_str() {
            "rm" => {
                // 只硬拦「递归 + 关键路径」：普通删除（含用户在审批里明确批准的
                // `rm -rf /tmp/build`）交由渲染进程的审批流程决定，硬拦会让合法操作
                // 永远无法执行。
                let recursive = has_short_flag(&args, 'r') || has_short_flag(&args, 'R')
                    || args.iter().any(|arg| arg == "--recursive");
                let fatal = args
                    .iter()
                    .filter(|arg| !arg.starts_with('-'))
                    .any(|arg| is_fatal_rm_target(arg));
                if recursive && fatal {
                    return Some("递归删除关键路径".to_string());
                }
            }
            "chmod" => {
                let recursive = has_short_flag(&args, 'R') || args.iter().any(|arg| arg == "--recursive");
                let all_perms = args.iter().any(|arg| arg == "777" || arg == "0777");
                if recursive && all_perms {
                    return Some("递归放开全部权限（777）".to_string());
                }
            }
            "dd" => {
                if args.iter().any(|arg| arg.starts_with("of=/dev/")) {
                    return Some("dd 直接写入块设备".to_string());
                }
            }
            "crontab" => {
                if args.iter().any(|arg| arg == "-r") {
                    return Some("crontab -r 清空全部定时任务".to_string());
                }
            }
            "init" => {
                if args
                    .iter()
                    .any(|arg| matches!(arg.to_lowercase().as_str(), "0" | "1" | "6" | "s"))
                {
                    return Some("init 切换运行级别会中断系统".to_string());
                }
            }
            "mv" => {
                if args.iter().any(|arg| arg == "/*") {
                    return Some("移动根目录全部内容".to_string());
                }
            }
            _ => {}
        }
    }

    None
}

/// 按未加引号的 `;` / `&&` / `||` / `|` / `&` / 换行切段。
fn split_command_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            current.push(ch);
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            current.push(ch);
            if ch == active {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            current.push(ch);
            quote = Some(ch);
            continue;
        }
        if ch == '\n' || ch == ';' || ch == '&' || ch == '|' {
            // 吃掉成对分隔符（&& / ||）
            if (ch == '&' || ch == '|') && chars.peek() == Some(&ch) {
                chars.next();
            }
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                segments.push(trimmed);
            }
            current.clear();
            continue;
        }
        current.push(ch);
    }

    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        segments.push(trimmed);
    }

    segments
}

/// 取一段命令真正的命令名与参数：跳过 `VAR=value` 赋值与 `sudo`/`env`/`timeout` 等前缀。
fn segment_head_and_args(segment: &str) -> Option<(String, Vec<String>)> {
    let tokens: Vec<String> = segment.split_whitespace().map(|token| token.to_string()).collect();
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index].as_str();
        if is_shell_assignment(token) {
            index += 1;
            continue;
        }

        let head = command_basename(token);

        if matches!(head.as_str(), "sudo" | "doas" | "su" | "runuser" | "pkexec") {
            index += 1;
            while index < tokens.len() && tokens[index].starts_with('-') {
                index += 1;
            }
            continue;
        }

        if matches!(
            head.as_str(),
            "command" | "env" | "nohup" | "setsid" | "nice" | "ionice" | "stdbuf" | "time"
                | "timeout" | "xargs" | "exec"
        ) {
            index += 1;
            while index < tokens.len() && is_wrapper_argument(&tokens[index]) {
                index += 1;
            }
            continue;
        }

        return Some((head, tokens[index + 1..].to_vec()));
    }

    None
}

fn is_wrapper_argument(token: &str) -> bool {
    if token.starts_with('-') {
        return true;
    }
    !token.is_empty()
        && token
            .chars()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, 's' | 'm' | 'h' | 'd'))
}

/// 规范化 rm 目标：去掉尾部斜杠（`/` 除外）并小写，便于与拒绝列表比对。
fn normalize_rm_target(target: &str) -> String {
    let trimmed = target.trim_end_matches('/');
    let normalized = if trimmed.is_empty() { "/" } else { trimmed };
    normalized.to_lowercase()
}

fn is_shell_assignment(token: &str) -> bool {
    let Some(eq) = token.find('=') else {
        return false;
    };
    if eq == 0 {
        return false;
    }
    let name = &token[..eq];
    let mut chars = name.chars();
    let first_ok = chars.next().map(|ch| ch.is_ascii_alphabetic() || ch == '_').unwrap_or(false);
    first_ok && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn command_basename(token: &str) -> String {
    let value = token.trim_matches(|ch| ch == '"' || ch == '\'');
    value
        .rsplit('/')
        .next()
        .unwrap_or(value)
        .to_lowercase()
}

/// 短选项检测，支持组合写法（`-rf` / `-fr` / `-Rf`）。
fn has_short_flag(args: &[String], flag: char) -> bool {
    args.iter().any(|arg| {
        let value = arg.trim_matches(|ch| ch == '"' || ch == '\'');
        if !value.starts_with('-') || value.starts_with("--") {
            return false;
        }
        value[1..].contains(flag)
    })
}

/// 获取默认的命令执行超时时间
///
/// # 参数
/// * `timeout_ms` - 可选的超时时间（毫秒）
///
/// # 返回
/// 如果提供了超时时间则返回该值，否则返回默认值（20分钟）
pub fn default_exec_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(command: &str) -> bool {
        find_blocked_reason(command).is_some()
    }

    #[test]
    fn guard_blocks_irreversible_commands() {
        for command in [
            "rm -rf /",
            "rm -fr /etc",
            "rm -r /var",
            "rm -rf --no-preserve-root /",
            "/bin/rm -rf /usr/lib",
            "sudo halt",
            "poweroff",
            "init 0",
            "telinit 6",
            "mkfs.ext4 /dev/sda1",
            "dd if=image.iso of=/dev/sda",
            "chmod -R 777 /var",
            "crontab -r",
            "mv /* /dev/null",
            ":(){ :|:& };:",
            "cat x > /dev/sda",
        ] {
            assert!(blocked(command), "应当拦截：{command}");
        }
    }

    #[test]
    fn guard_allows_ordinary_commands() {
        for command in [
            // 旧实现子串匹配的误伤样例
            "grep -i shutdown /var/log/syslog",
            "echo \"rm -rf /tmp/demo\"",
            "systemctl status shutdown.target",
            // 合法删除：交给渲染进程审批，而不是硬拦
            "rm -rf /tmp/build",
            "rm report.txt",
            "/bin/rm -rf /var/tmp/cache",
            "systemctl restart nginx",
            "ls -la /",
            "timeout 30 sh -c \"echo hi\"",
        ] {
            assert!(!blocked(command), "不应拦截：{command}");
        }
    }

    #[test]
    fn unregister_only_removes_its_own_handle() {
        let service = AgentService::new();
        let (first_tx, _first_rx) = oneshot::channel();
        let (second_tx, mut second_rx) = oneshot::channel();

        service.pending_execs.lock().unwrap().insert(
            "c1".to_string(),
            PendingExecHandle { cancel: first_tx, run_id: "run-a".to_string() },
        );
        // 后发起的执行顶替前一个：旧句柄被取出（此时 Sender 已 drop，旧执行会自行收尾）
        let superseded = service.pending_execs.lock().unwrap().insert(
            "c1".to_string(),
            PendingExecHandle { cancel: second_tx, run_id: "run-b".to_string() },
        );
        drop(superseded);

        // 先完成的 run-a 注销时不得删掉 run-b 的句柄
        service.unregister_exec("c1", "run-a");
        assert!(service.pending_execs.lock().unwrap().contains_key("c1"));

        // 未被顶替的执行仍然可以被取消
        assert!(service.cancel_exec("c1").unwrap());
        assert!(second_rx.try_recv().is_ok());

        // 只有句柄的主人注销时才真正移除
        service.unregister_exec("c1", "run-b");
        assert!(!service.pending_execs.lock().unwrap().contains_key("c1"));
    }

    #[test]
    fn cancel_exec_is_scoped_to_one_connection() {
        let service = AgentService::new();
        let (first_tx, mut first_rx) = oneshot::channel();
        let (second_tx, mut second_rx) = oneshot::channel();

        service.pending_execs.lock().unwrap().insert(
            "c1".to_string(),
            PendingExecHandle { cancel: first_tx, run_id: "a".to_string() },
        );
        service.pending_execs.lock().unwrap().insert(
            "c2".to_string(),
            PendingExecHandle { cancel: second_tx, run_id: "b".to_string() },
        );

        assert!(service.cancel_exec("c1").unwrap());
        assert!(first_rx.try_recv().is_ok());
        assert!(second_rx.try_recv().is_err());
        assert!(service.pending_execs.lock().unwrap().contains_key("c2"));
    }

    #[test]
    fn cancel_all_execs_still_covers_every_connection() {
        let service = AgentService::new();
        let (first_tx, mut first_rx) = oneshot::channel();
        let (second_tx, mut second_rx) = oneshot::channel();

        service.pending_execs.lock().unwrap().insert(
            "c1".to_string(),
            PendingExecHandle { cancel: first_tx, run_id: "a".to_string() },
        );
        service.pending_execs.lock().unwrap().insert(
            "c2".to_string(),
            PendingExecHandle { cancel: second_tx, run_id: "b".to_string() },
        );

        assert_eq!(service.cancel_all_execs().unwrap(), 2);
        assert!(first_rx.try_recv().is_ok());
        assert!(second_rx.try_recv().is_ok());
        assert!(service.pending_execs.lock().unwrap().is_empty());
    }

    #[test]
    fn guard_error_carries_policy_marker() {
        let error = check_command_guard("rm -rf /").expect_err("应当被拦截");
        assert!(error.to_string().contains("AGENT_POLICY_BLOCKED"));
    }

    #[test]
    fn buffer_trim_keeps_sentinel_line() {
        let mut buffer = String::new();
        while buffer.len() <= MAX_BUFFER_SIZE + KEEP_BUFFER_SIZE {
            buffer.push_str("中文输出行 abcdefghijklmnopqrstuvwxyz\n");
        }
        buffer.push_str("__AGENT_DONE_run1__:0\n");

        trim_exec_buffer(&mut buffer);

        assert!(buffer.len() < MAX_BUFFER_SIZE, "裁剪后必须低于上限");
        assert!(
            buffer.contains("__AGENT_DONE_run1__:0\n"),
            "哨兵行不能被裁掉，否则退出码永远解析不到"
        );
    }

    #[test]
    fn buffer_trim_survives_multibyte_cut_point() {
        let mut buffer = String::from("a");
        while buffer.len() < MAX_BUFFER_SIZE + KEEP_BUFFER_SIZE {
            buffer.push('中');
        }
        buffer.push('\n');
        buffer.push_str("__AGENT_DONE_x__:1\n");

        // 旧实现直接按字节切片，切点落在多字节字符中间会 panic
        trim_exec_buffer(&mut buffer);

        assert!(buffer.ends_with("__AGENT_DONE_x__:1\n"));
    }
}
