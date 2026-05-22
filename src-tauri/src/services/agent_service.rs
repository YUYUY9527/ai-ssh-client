use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::error::{app_error, AppResult};
use crate::services::ssh_service::SshService;

const SENTINEL_PREFIX: &str = "__AGENT_DONE_";
const DEFAULT_EXEC_TIMEOUT_MS: u64 = 20 * 60 * 1000;
const MAX_BUFFER_SIZE: usize = 1024 * 1024;
const KEEP_BUFFER_SIZE: usize = 768 * 1024;

/// Agent bridge for terminal output and sentinel-based command execution.
pub struct AgentService {
    tasks: Arc<Mutex<HashMap<String, AgentTaskHandle>>>,
    pending_execs: Arc<Mutex<HashMap<String, PendingExecHandle>>>,
}

struct AgentTaskHandle {
    cancel: oneshot::Sender<()>,
}

struct PendingExecHandle {
    cancel: oneshot::Sender<()>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExecAwaitResult {
    pub output: String,
    pub exit_code: Option<i32>,
    pub reason: String,
}

impl AgentService {
    /// Creates an empty agent bridge.
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(Mutex::new(HashMap::new())),
            pending_execs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Starts forwarding terminal output for an agent task.
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

    /// Stops forwarding output and cancels pending execution for a connection.
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

    /// Executes a command and resolves when a sentinel marker is observed.
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
                    break AgentExecAwaitResult {
                        output: buffer,
                        exit_code: None,
                        reason: "canceled".to_string(),
                    };
                }
                _ = &mut timeout => {
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

    /// Cancels a pending exec wait.
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

    /// Cancels every pending exec wait.
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

#[derive(Default)]
struct SentinelStripper {
    buffer: String,
}

impl SentinelStripper {
    fn feed(&mut self, chunk: &str) -> String {
        self.buffer.push_str(chunk);
        let output = strip_complete_sentinel_artifacts(&self.buffer);
        self.buffer.clear();
        output
    }

    fn flush(&mut self) -> String {
        let output = strip_complete_sentinel_artifacts(&self.buffer);
        self.buffer.clear();
        output
    }
}

fn make_sentinel_marker(run_id: &str) -> String {
    format!("{SENTINEL_PREFIX}{run_id}__")
}

fn wrap_command_with_sentinel(command: &str, run_id: &str) -> String {
    let marker = make_sentinel_marker(run_id);
    let trimmed = command.trim_end_matches(['\r', '\n']);

    if trimmed.contains('\n') || trimmed.contains("<<") {
        return format!("\r{trimmed}\n__ais_ec=$?; printf '\\n{marker}:%s\\n' \"$__ais_ec\"\n");
    }

    format!("\r({trimmed}); printf '\\n{marker}:%s\\n' \"$?\"\n")
}

fn format_agent_command_echo(command: &str) -> String {
    let trimmed = command.trim_end_matches(['\r', '\n']);
    format!("\r\n{trimmed}\r\n")
}

fn parse_sentinel(buffer: &str, marker: &str) -> Option<(String, i32)> {
    for (marker_index, _) in buffer.match_indices(marker) {
        let after_marker = &buffer[marker_index + marker.len()..];
        let Some(exit_code_text) = after_marker.strip_prefix(':') else {
            continue;
        };
        let exit_code_line = exit_code_text
            .split(['\r', '\n'])
            .next()
            .unwrap_or_default()
            .trim();
        let Ok(exit_code) = exit_code_line.parse::<i32>() else {
            continue;
        };
        return Some((buffer[..marker_index].to_string(), exit_code));
    }

    None
}

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

fn strip_complete_sentinel_artifacts(input: &str) -> String {
    input
        .lines()
        .filter(|line| !line.contains(SENTINEL_PREFIX) && !line.contains("__ais_ec=$?; printf"))
        .collect::<Vec<_>>()
        .join("\n")
}

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

pub fn default_exec_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS)
}
