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

        if self
            .pending_execs
            .lock()
            .map_err(|_| app_error("Agent 执行状态锁已损坏"))?
            .contains_key(&connection_id)
        {
            self.cancel_exec(&connection_id).ok();
        }

        let mut output_rx = ssh.subscribe_output(&connection_id)?;
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        self.pending_execs
            .lock()
            .map_err(|_| app_error("Agent 执行状态锁已损坏"))?
            .insert(
                connection_id.clone(),
                PendingExecHandle { cancel: cancel_tx },
            );

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
                        break AgentExecAwaitResult {
                            output: String::new(),
                            exit_code: None,
                            reason: "closed".to_string(),
                        };
                    };
                    buffer.push_str(&data);
                    if buffer.len() > MAX_BUFFER_SIZE {
                        buffer = buffer[buffer.len().saturating_sub(KEEP_BUFFER_SIZE)..].to_string();
                    }
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
                    break AgentExecAwaitResult {
                        output: buffer,
                        exit_code: None,
                        reason: "canceled".to_string(),
                    };
                }
                _ = &mut timeout => {
                    let _ = ssh.execute(&connection_id, "\u{3}".to_string());
                    tokio::time::sleep(Duration::from_millis(INTERRUPT_SETTLE_MS)).await;
                    break AgentExecAwaitResult {
                        output: buffer,
                        exit_code: None,
                        reason: "timeout".to_string(),
                    };
                }
            }
        };

        self.unregister_exec(&connection_id);
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
    fn unregister_exec(&self, connection_id: &str) {
        if let Ok(mut guard) = self.pending_execs.lock() {
            guard.remove(connection_id);
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

/// 检查命令安全性，阻止危险命令执行
///
/// 拦截可能导致系统损坏的命令（如 rm -rf /、mkfs 等）
///
/// # 参数
/// * `command` - 要检查的命令
///
/// # 返回
/// 如果命令安全返回 Ok，否则返回错误
fn check_command_guard(command: &str) -> AppResult<()> {
    let normalized = command.trim().to_lowercase();
    let critical_patterns = [
        "rm -rf /",
        "rm -rf /*",
        "mkfs",
        "dd if=",
        ":(){",
        "shutdown",
        "reboot",
        "poweroff",
    ];

    if critical_patterns
        .iter()
        .any(|pattern| normalized.contains(pattern))
    {
        return Err(app_error("命令被安全策略阻止"));
    }

    Ok(())
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
