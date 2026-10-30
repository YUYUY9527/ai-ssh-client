use std::collections::HashMap;
use std::net::ToSocketAddrs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh::client::{self, AuthResult, Handle};
use russh::keys::{decode_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, Pty};
use russh_sftp::client::{Config as SftpConfig, SftpSession};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

use crate::error::{app_error, AppResult};
use crate::models::settings::AppSettings;
use crate::models::ssh::{
    HostTrustPromptEvent, HostTrustPromptKind, HostTrustRecord, SshConnection, SshEvent,
    SshSessionState,
};
use crate::services::sentinel::SentinelStripper;
use crate::services::storage_service::StorageService;

/// How long to wait for the user to accept/reject a host key.
const HOST_TRUST_PROMPT_TIMEOUT_SECS: u64 = 90;

enum SshControl {
    Input(String),
    Resize { cols: u32, rows: u32 },
    Shutdown,
}

const SFTP_REQUEST_TIMEOUT_SECS: u64 = 120;

struct SshSession {
    connection: SshConnection,
    state: SshSessionState,
    control: mpsc::UnboundedSender<SshControl>,
    output_subscribers: Vec<mpsc::UnboundedSender<String>>,
    /// 单调递增的实例代号：每次 connect 生成一个新值，用来区分「同 connection_id 的
    /// 旧会话」和「重连后的新会话」。所有按 id 对 map 的写操作都必须先校验它，
    /// 否则旧任务的清理会把新会话误删/误标为断开。
    generation: u64,
}

pub(crate) type PendingTrustMap = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

#[derive(Clone)]
pub(crate) struct SshHandler {
    host: String,
    port: u16,
    storage: Arc<StorageService>,
    app_handle: AppHandle,
    pending_trust: PendingTrustMap,
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // 已信任则直接通过；首次或密钥变更时弹窗等待前端确认
        let algorithm = server_public_key.algorithm().to_string();
        let fingerprint = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();

        let existing = self
            .storage
            .get_host_trust_record(&self.host, self.port)
            .map_err(|err| {
                russh::Error::IO(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    err.to_string(),
                ))
            })?;

        if let Some(existing) = existing.as_ref() {
            if existing.fingerprint == fingerprint && existing.algorithm == algorithm {
                return Ok(true);
            }
        }

        let kind = if existing.is_some() {
            HostTrustPromptKind::KeyChanged
        } else {
            HostTrustPromptKind::FirstConnect
        };
        let accepted = wait_for_host_trust_decision(
            &self.app_handle,
            &self.pending_trust,
            HostTrustPromptEvent {
                request_id: uuid::Uuid::new_v4().to_string(),
                host: self.host.clone(),
                port: self.port,
                algorithm: algorithm.clone(),
                fingerprint: fingerprint.clone(),
                kind,
                previous_algorithm: existing.as_ref().map(|item| item.algorithm.clone()),
                previous_fingerprint: existing.as_ref().map(|item| item.fingerprint.clone()),
            },
        )
        .await?;

        if !accepted {
            return Err(russh::Error::KeyChanged { line: 0 });
        }

        let trusted_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        self.storage
            .upsert_host_trust_record(HostTrustRecord {
                host: self.host.clone(),
                port: self.port,
                algorithm,
                fingerprint,
                trusted_at,
            })
            .map_err(|err| {
                russh::Error::IO(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    err.to_string(),
                ))
            })?;
        Ok(true)
    }
}

/// SSH session registry and transport.
#[derive(Clone)]
pub struct SshService {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    storage: Arc<StorageService>,
    pending_trust: PendingTrustMap,
    /// Monotonic session-instance counter assigned on every insert.
    next_generation: Arc<AtomicU64>,
}

impl SshService {
    /// Creates an SSH service bound to the shared storage layer.
    pub fn new(storage: Arc<StorageService>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            storage,
            pending_trust: Arc::new(Mutex::new(HashMap::new())),
            next_generation: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Resolves a pending host-key confirmation from the frontend.
    pub fn respond_host_trust(&self, request_id: &str, accepted: bool) -> AppResult<()> {
        let mut pending = self
            .pending_trust
            .lock()
            .map_err(|_| app_error("主机信任状态锁已损坏"))?;
        let Some(sender) = pending.remove(request_id) else {
            return Err(app_error("信任确认请求不存在或已过期"));
        };
        let _ = sender.send(accepted);
        Ok(())
    }

    /// Starts an interactive SSH shell and emits terminal output to the frontend.
    pub async fn connect(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        cols: u32,
        rows: u32,
        settings: Option<AppSettings>,
    ) -> AppResult<String> {
        let session_id = connection.id.clone();
        let (control_tx, control_rx) = mpsc::unbounded_channel::<SshControl>();

        self.disconnect(&session_id).ok();
        let generation = self.insert_session(
            session_id.clone(),
            connection.clone(),
            SshSessionState {
                connection_id: session_id.clone(),
                is_connected: false,
                is_connecting: true,
                reconnect_attempts: 0,
                last_error: None,
            },
            control_tx.clone(),
        )?;

        let sessions = Arc::clone(&self.sessions);
        let storage = Arc::clone(&self.storage);
        let pending_trust = Arc::clone(&self.pending_trust);
        let setup_result = start_shell_task(
            app_handle,
            Arc::clone(&sessions),
            storage,
            pending_trust,
            session_id.clone(),
            generation,
            connection,
            cols,
            rows,
            settings,
            control_rx,
        )
        .await;

        if let Err(error) = setup_result {
            // Only clean up when the stored session is still this generation: a newer
            // connect may already have replaced it, and removing it would kill the new one.
            remove_session_if_generation(&sessions, &session_id, generation);
            return Err(error);
        }

        Ok(session_id)
    }

    /// Disconnects a tracked SSH session.
    pub fn disconnect(&self, connection_id: &str) -> AppResult<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        if let Some(session) = sessions.remove(connection_id) {
            let _ = session.control.send(SshControl::Shutdown);
        }
        Ok(())
    }

    /// Sends raw terminal input to a shell.
    pub fn execute(&self, connection_id: &str, command: String) -> AppResult<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        let Some(session) = sessions.get(connection_id) else {
            return Err(app_error("Session not found"));
        };
        session
            .control
            .send(SshControl::Input(command))
            .map_err(|_| app_error("SSH 会话已关闭"))
    }

    /// Emits text to the visible terminal without sending it to the remote shell.
    pub fn emit_terminal_data(&self, app_handle: &AppHandle, connection_id: &str, data: String) {
        emit_ssh_data(app_handle, connection_id, data);
    }

    /// Subscribes to raw terminal output for a tracked SSH session.
    pub fn subscribe_output(
        &self,
        connection_id: &str,
    ) -> AppResult<mpsc::UnboundedReceiver<String>> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        let Some(session) = sessions.get_mut(connection_id) else {
            return Err(app_error("Session not found"));
        };
        let (tx, rx) = mpsc::unbounded_channel();
        session.output_subscribers.push(tx);
        Ok(rx)
    }

    /// Resizes a remote PTY.
    pub fn resize(&self, connection_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        let Some(session) = sessions.get(connection_id) else {
            return Ok(());
        };
        session
            .control
            .send(SshControl::Resize { cols, rows })
            .map_err(|_| app_error("SSH 会话已关闭"))
    }

    /// Returns all tracked session states.
    pub fn get_session_states(&self) -> AppResult<Vec<SshSessionState>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        Ok(sessions
            .values()
            .map(|session| session.state.clone())
            .collect())
    }

    /// Tests an SSH connection by authenticating and disconnecting.
    pub async fn test_connection(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
    ) -> AppResult<()> {
        let storage = Arc::clone(&self.storage);
        let pending_trust = Arc::clone(&self.pending_trust);
        let session =
            connect_authenticated_session(&connection, None, storage, app_handle, pending_trust)
                .await?;
        session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await?;
        Ok(())
    }

    /// Returns the connection config owned by a currently tracked session.
    pub fn runtime_connection(&self, connection_id: &str) -> AppResult<Option<SshConnection>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        Ok(sessions
            .get(connection_id)
            .map(|session| session.connection.clone()))
    }

    pub(crate) fn storage(&self) -> Arc<StorageService> {
        Arc::clone(&self.storage)
    }

    pub(crate) fn pending_trust(&self) -> PendingTrustMap {
        Arc::clone(&self.pending_trust)
    }

    fn insert_session(
        &self,
        connection_id: String,
        connection: SshConnection,
        state: SshSessionState,
        control: mpsc::UnboundedSender<SshControl>,
    ) -> AppResult<u64> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        sessions.insert(
            connection_id,
            SshSession {
                connection,
                state,
                control,
                output_subscribers: Vec::new(),
                generation,
            },
        );
        Ok(generation)
    }
}


pub(crate) fn sftp_protocol_path(path: &str) -> String {
    if path == "~" {
        ".".to_string()
    } else if let Some(relative) = path.strip_prefix("~/") {
        format!("./{relative}")
    } else {
        path.to_string()
    }
}

pub(crate) fn validate_sftp_item_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\0')
    {
        return Err(app_error("Invalid SFTP item name"));
    }
    Ok(())
}

pub(crate) fn validate_sftp_item_path(path: &str) -> AppResult<()> {
    let trimmed = path.trim();
    let compact = trimmed.trim_end_matches('/');
    // 在协议路径上按段计算深度，兼容 `~`（映射为 `.`）等相对路径写法。
    let protocol = sftp_protocol_path(trimmed);
    let is_absolute = protocol.starts_with('/');
    let mut depth = 0_usize;
    let mut escaped = false;
    for part in protocol.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if depth == 0 {
                    if !is_absolute {
                        escaped = true;
                    }
                } else {
                    depth -= 1;
                }
            }
            _ => depth += 1,
        }
    }
    if compact.is_empty()
        || matches!(compact, "." | "~")
        || (is_absolute && depth == 0)
        || (!is_absolute && (escaped || depth == 0))
    {
        return Err(app_error("Protected SFTP path"));
    }
    Ok(())
}

pub(crate) fn sftp_sibling_path(remote_path: &str, new_name: &str) -> AppResult<String> {
    validate_sftp_item_path(remote_path)?;
    validate_sftp_item_name(new_name)?;
    let source = remote_path.trim_end_matches('/');
    Ok(match source.rsplit_once('/') {
        Some(("", _)) => format!("/{new_name}"),
        Some((parent, _)) => format!("{parent}/{new_name}"),
        None => new_name.to_string(),
    })
}

pub(crate) fn sftp_child_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{name}", parent.trim_end_matches('/'))
    }
}

impl Default for SshService {
    fn default() -> Self {
        // Default only for tests; production wires storage via AppState.
        let storage = Arc::new(
            StorageService::new().unwrap_or_else(|_| panic!("failed to init default storage")),
        );
        Self::new(storage)
    }
}

async fn start_shell_task(
    app_handle: AppHandle,
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    storage: Arc<StorageService>,
    pending_trust: PendingTrustMap,
    session_id: String,
    generation: u64,
    connection: SshConnection,
    cols: u32,
    rows: u32,
    settings: Option<AppSettings>,
    mut control_rx: mpsc::UnboundedReceiver<SshControl>,
) -> AppResult<()> {
    let session = connect_authenticated_session(
        &connection,
        settings.as_ref(),
        storage,
        app_handle.clone(),
        pending_trust,
    )
    .await?;

    // A newer connect for the same connection_id may have replaced this session while the
    // handshake was in flight. Never leave an orphan russh connection behind: drop it and
    // return without spawning a shell loop that would fight the new session.
    if !is_current_generation(&sessions, &session_id, generation) {
        let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
        return Ok(());
    }

    let mut channel = session.channel_open_session().await?;
    channel
        .request_pty(
            true,
            "xterm-256color",
            cols,
            rows,
            0,
            0,
            &[] as &[(Pty, u32)],
        )
        .await?;
    channel.request_shell(true).await?;

    let task_session_id = session_id.clone();
    let task_sessions = sessions.clone();
    let task_app_handle = app_handle.clone();
    let task_generation = generation;
    tauri::async_runtime::spawn(async move {
        // Notify frontend that connection is ready ONLY after the input loop is about to start.
        // This prevents a race where users can send input before the select loop begins processing.
        // Guarded by generation: a superseding connect must not let this task announce readiness
        // (or overwrite state) for the new instance that already took the id.
        if is_current_generation(&task_sessions, &task_session_id, task_generation) {
            let state = SshSessionState {
                connection_id: task_session_id.clone(),
                is_connected: true,
                is_connecting: false,
                reconnect_attempts: 0,
                last_error: None,
            };
            emit_ssh_state(&task_app_handle, state.clone());
            update_session_state_if_generation(&task_sessions, task_generation, state);
            emit_ssh_data(&task_app_handle, &task_session_id, "\r\n".to_string());
        }

        let mut visible_stripper = SentinelStripper::default();
        let mut stdout_decoder = Utf8ChunkDecoder::new();
        let mut stderr_decoder = Utf8ChunkDecoder::new();
        loop {
            tokio::select! {
                Some(control) = control_rx.recv() => {
                    match control {
                        SshControl::Input(input) => {
                            if let Err(error) = channel.data(input.as_bytes()).await {
                                emit_ssh_error(&task_app_handle, &task_session_id, &error.to_string());
                                break;
                            }
                        }
                        SshControl::Resize { cols, rows } => {
                            if let Err(error) = channel.window_change(cols, rows, 0, 0).await {
                                emit_ssh_error(&task_app_handle, &task_session_id, &error.to_string());
                                break;
                            }
                        }
                        SshControl::Shutdown => {
                            let _ = channel.close().await;
                            break;
                        }
                    }
                }
                 msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let text = stdout_decoder.push(&data);
                            if !text.is_empty()
                                && broadcast_session_output_if_generation(
                                    &task_sessions,
                                    &task_session_id,
                                    task_generation,
                                    &text,
                                )
                            {
                                let visible_text = visible_stripper.feed(&text);
                                if !visible_text.is_empty() {
                                    emit_ssh_data(&task_app_handle, &task_session_id, visible_text);
                                }
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let text = stderr_decoder.push(&data);
                            if !text.is_empty()
                                && broadcast_session_output_if_generation(
                                    &task_sessions,
                                    &task_session_id,
                                    task_generation,
                                    &text,
                                )
                            {
                                emit_ssh_error(&task_app_handle, &task_session_id, &text);
                            }
                        }
                        Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        // Drain any bytes held back by the incremental decoders so a trailing multi-byte
        // character split across the last packet is not silently dropped.
        let stdout_tail = stdout_decoder.finish();
        if !stdout_tail.is_empty()
            && broadcast_session_output_if_generation(
                &task_sessions,
                &task_session_id,
                task_generation,
                &stdout_tail,
            )
        {
            let visible = visible_stripper.feed(&stdout_tail);
            if !visible.is_empty() {
                emit_ssh_data(&task_app_handle, &task_session_id, visible);
            }
        }
        let stderr_tail = stderr_decoder.finish();
        if !stderr_tail.is_empty()
            && broadcast_session_output_if_generation(
                &task_sessions,
                &task_session_id,
                task_generation,
                &stderr_tail,
            )
        {
            emit_ssh_error(&task_app_handle, &task_session_id, &stderr_tail);
        }

        let visible_tail = visible_stripper.flush();
        if !visible_tail.is_empty()
            && is_current_generation(&task_sessions, &task_session_id, task_generation)
        {
            emit_ssh_data(&task_app_handle, &task_session_id, visible_tail);
        }

        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        update_session_state_if_generation(
            &task_sessions,
            task_generation,
            SshSessionState {
                connection_id: task_session_id.clone(),
                is_connected: false,
                is_connecting: false,
                reconnect_attempts: 0,
                last_error: None,
            },
        );
        // Only emit ssh-close when we actually retired the current instance; a stale task
        // must not tell the frontend that the freshly reconnected session closed.
        if remove_session_if_generation(&task_sessions, &task_session_id, task_generation) {
            let _ = task_app_handle.emit("ssh-close", task_session_id);
        }
    });

    Ok(())
}

async fn connect_authenticated_session(
    connection: &SshConnection,
    settings: Option<&AppSettings>,
    storage: Arc<StorageService>,
    app_handle: AppHandle,
    pending_trust: PendingTrustMap,
) -> AppResult<Handle<SshHandler>> {
    let addrs = (connection.host.as_str(), connection.port)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| app_error("无法解析 SSH 地址"))?;

    let mut config = client::Config::default();
    if let Some(settings) = settings {
        if settings.keepalive_interval > 0 {
            config.keepalive_interval = Some(Duration::from_secs(settings.keepalive_interval));
            config.keepalive_max = settings.keepalive_count_max as usize;
        }
    }

    let handler = SshHandler {
        host: connection.host.trim().to_ascii_lowercase(),
        port: connection.port,
        storage,
        app_handle,
        pending_trust,
    };
    let mut session = client::connect(Arc::new(config), addrs, handler).await?;

    // Only trim to TEST emptiness; authenticate with the ORIGINAL password so leading/trailing
    // spaces (which the storage layer and forms preserve) are sent verbatim.
    if let Some(password) = non_empty_secret(connection.password.as_ref()) {
        let auth = session
            .authenticate_password(&connection.username, password)
            .await?;
        ensure_auth_success(auth)?;
        return Ok(session);
    }

    if let Some(private_key) = connection
        .private_key
        .as_ref()
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let key = decode_secret_key(private_key, connection.passphrase.as_deref())?;
        let auth = session
            .authenticate_publickey(
                &connection.username,
                PrivateKeyWithHashAlg::new(
                    Arc::new(key),
                    session.best_supported_rsa_hash().await?.flatten(),
                ),
            )
            .await?;
        ensure_auth_success(auth)?;
        return Ok(session);
    }

    Err(app_error("缺少 SSH 密码或私钥"))
}

pub(crate) async fn open_sftp_session(
    connection: &SshConnection,
    storage: Arc<StorageService>,
    app_handle: AppHandle,
    pending_trust: PendingTrustMap,
) -> AppResult<(SftpSession, Handle<SshHandler>)> {
    let session =
        connect_authenticated_session(connection, None, storage, app_handle, pending_trust).await?;
    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let mut config = SftpConfig::default();
    config.request_timeout_secs = SFTP_REQUEST_TIMEOUT_SECS;
    let sftp = SftpSession::new_with_config(channel.into_stream(), config).await?;
    Ok((sftp, session))
}

/// 向前端发出主机指纹确认事件，并阻塞等待 accept/reject（带超时）。
async fn wait_for_host_trust_decision(
    app_handle: &AppHandle,
    pending_trust: &PendingTrustMap,
    prompt: HostTrustPromptEvent,
) -> Result<bool, russh::Error> {
    let request_id = prompt.request_id.clone();
    let (tx, rx) = oneshot::channel();

    {
        let mut pending = pending_trust.lock().map_err(|_| {
            russh::Error::IO(std::io::Error::new(
                std::io::ErrorKind::Other,
                "主机信任状态锁已损坏",
            ))
        })?;
        pending.insert(request_id.clone(), tx);
    }

    if app_handle.emit("ssh-host-trust-prompt", prompt).is_err() {
        if let Ok(mut pending) = pending_trust.lock() {
            pending.remove(&request_id);
        }
        return Err(russh::Error::IO(std::io::Error::new(
            std::io::ErrorKind::Other,
            "无法发送主机指纹确认请求",
        )));
    }

    match tokio::time::timeout(Duration::from_secs(HOST_TRUST_PROMPT_TIMEOUT_SECS), rx).await {
        Ok(Ok(accepted)) => Ok(accepted),
        Ok(Err(_)) => Err(russh::Error::IO(std::io::Error::new(
            std::io::ErrorKind::Other,
            "主机指纹确认通道已关闭",
        ))),
        Err(_) => {
            if let Ok(mut pending) = pending_trust.lock() {
                pending.remove(&request_id);
            }
            Err(russh::Error::IO(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "主机指纹确认超时",
            )))
        }
    }
}


fn ensure_auth_success(auth: AuthResult) -> AppResult<()> {
    if auth.success() {
        Ok(())
    } else {
        Err(app_error("SSH 认证失败"))
    }
}

/// Returns the original secret string when it is not blank after trimming.
///
/// Trimming is used ONLY to decide whether a secret is present; the returned value is the
/// untouched input so meaningful leading/trailing spaces survive authentication.
fn non_empty_secret(value: Option<&String>) -> Option<&str> {
    value
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
}

/// Stateful UTF-8 decoder for a byte stream delivered in arbitrary chunks.
///
/// `String::from_utf8_lossy` per chunk corrupts a multi-byte character that straddles a TCP
/// packet boundary. This decoder keeps the incomplete trailing bytes until the next chunk and
/// only substitutes U+FFFD for bytes that are truly invalid.
#[derive(Default)]
struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// Decodes as much of `chunk` as possible, retaining any incomplete trailing sequence.
    fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() {
            return String::new();
        }

        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);

        let mut output = String::with_capacity(bytes.len());
        let mut cursor = 0usize;
        while cursor < bytes.len() {
            match std::str::from_utf8(&bytes[cursor..]) {
                Ok(valid) => {
                    output.push_str(valid);
                    cursor = bytes.len();
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    if valid_up_to > 0 {
                        // Safe: `from_utf8` proved this prefix is valid UTF-8.
                        output.push_str(
                            std::str::from_utf8(&bytes[cursor..cursor + valid_up_to])
                                .expect("valid UTF-8 prefix"),
                        );
                        cursor += valid_up_to;
                    }
                    match error.error_len() {
                        Some(len) => {
                            // Truly invalid bytes: emit a replacement char and skip them.
                            output.push('\u{FFFD}');
                            cursor += len;
                        }
                        None => {
                            // Incomplete trailing sequence: keep it for the next chunk.
                            self.pending.extend_from_slice(&bytes[cursor..]);
                            break;
                        }
                    }
                }
            }
        }
        output
    }

    /// Flushes any held incomplete tail, replacing it with U+FFFD where invalid.
    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let pending = std::mem::take(&mut self.pending);
        String::from_utf8_lossy(&pending).into_owned()
    }
}

/// True only while `connection_id` is still mapped to the given `generation`.
///
/// Every mutation of session state / removal / output broadcast goes through this check so a
/// stale shell task (from an older connect that lost the race) can never clobber the session
/// that currently owns the id.
fn is_current_generation(
    sessions: &Arc<Mutex<HashMap<String, SshSession>>>,
    connection_id: &str,
    generation: u64,
) -> bool {
    sessions
        .lock()
        .map(|guard| {
            guard
                .get(connection_id)
                .map(|session| session.generation == generation)
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

/// Updates stored state only when the id still belongs to `generation`.
fn update_session_state_if_generation(
    sessions: &Arc<Mutex<HashMap<String, SshSession>>>,
    generation: u64,
    state: SshSessionState,
) {
    if let Ok(mut guard) = sessions.lock() {
        if let Some(session) = guard.get_mut(&state.connection_id) {
            if session.generation == generation {
                session.state = state;
            }
        }
    }
}

/// Removes the session only when it still belongs to `generation`; returns whether it removed.
fn remove_session_if_generation(
    sessions: &Arc<Mutex<HashMap<String, SshSession>>>,
    connection_id: &str,
    generation: u64,
) -> bool {
    if let Ok(mut guard) = sessions.lock() {
        let owned_by_caller = guard
            .get(connection_id)
            .map(|session| session.generation == generation)
            .unwrap_or(false);
        if owned_by_caller {
            guard.remove(connection_id);
            return true;
        }
    }
    false
}

/// Broadcasts to output subscribers only while `generation` is current; returns whether the
/// session was current (so callers can skip emitting to the frontend as well).
fn broadcast_session_output_if_generation(
    sessions: &Arc<Mutex<HashMap<String, SshSession>>>,
    connection_id: &str,
    generation: u64,
    data: &str,
) -> bool {
    if let Ok(mut guard) = sessions.lock() {
        if let Some(session) = guard.get_mut(connection_id) {
            if session.generation == generation {
                session
                    .output_subscribers
                    .retain(|subscriber| subscriber.send(data.to_string()).is_ok());
                return true;
            }
        }
    }
    false
}

fn emit_ssh_state(app_handle: &AppHandle, state: SshSessionState) {
    let payload = SshEvent {
        connection_id: state.connection_id.clone(),
        data: String::new(),
        event_type: "state".to_string(),
        state: Some(state),
    };
    let _ = app_handle.emit("ssh-data", payload);
}

fn emit_ssh_data(app_handle: &AppHandle, connection_id: &str, data: String) {
    let payload = SshEvent {
        connection_id: connection_id.to_string(),
        data,
        event_type: "data".to_string(),
        state: None,
    };
    let _ = app_handle.emit("ssh-data", payload);
}

fn emit_ssh_error(app_handle: &AppHandle, connection_id: &str, error: &str) {
    let payload = json!({
        "connectionId": connection_id,
        "error": error,
    });
    let _ = app_handle.emit("ssh-error", payload);
}


#[cfg(test)]
mod tests {
    use super::{
        non_empty_secret, sftp_child_path, sftp_protocol_path, sftp_sibling_path,
        validate_sftp_item_name, validate_sftp_item_path, Utf8ChunkDecoder,
    };

    #[test]
    fn converts_shell_home_paths_for_sftp() {
        assert_eq!(sftp_protocol_path(""), "");
        assert_eq!(sftp_protocol_path("~"), ".");
        assert_eq!(sftp_protocol_path("~/"), "./");
        assert_eq!(sftp_protocol_path("~/project"), "./project");
        assert_eq!(sftp_protocol_path("~/../shared"), "./../shared");
        assert_eq!(sftp_protocol_path("/var/log"), "/var/log");
    }

    #[test]
    fn validates_sftp_item_names_and_paths() {
        for name in ["", "  ", ".", "..", "a/b", "a\0b"] {
            assert!(validate_sftp_item_name(name).is_err());
        }
        assert!(validate_sftp_item_name("report.txt").is_ok());

        for path in [
            "",
            "/",
            "//",
            "/./",
            "/tmp/..",
            ".",
            "~",
            "~/",
            "..",
            "~/..",
            "~/../..",
            "../x",
            "a/../../b",
            "foo/..",
        ] {
            assert!(validate_sftp_item_path(path).is_err());
        }
        assert!(validate_sftp_item_path("~/project").is_ok());
        assert!(validate_sftp_item_path("/tmp/file").is_ok());
    }

    #[test]
    fn builds_posix_sftp_item_paths() {
        assert_eq!(
            sftp_sibling_path("/tmp/old.txt", "new.txt").unwrap(),
            "/tmp/new.txt"
        );
        assert_eq!(
            sftp_sibling_path("~/old.txt", "new.txt").unwrap(),
            "~/new.txt"
        );
        assert_eq!(sftp_child_path("/", "tmp"), "/tmp");
        assert_eq!(sftp_child_path("./project", "src"), "./project/src");
    }

    #[test]
    fn utf8_decoder_reassembles_char_split_across_chunks() {
        // "中" = E4 B8 AD, "文" = E6 96 87. Split inside "中" so the first chunk's trailing
        // bytes are an incomplete sequence.
        let bytes = "中文".as_bytes();
        let mut decoder = Utf8ChunkDecoder::new();
        let first = decoder.push(&bytes[..1]); // just E4
        assert_eq!(first, "", "incomplete head must not be emitted");
        let second = decoder.push(&bytes[1..]);
        assert_eq!(first + &second, "中文");
    }

    #[test]
    fn utf8_decoder_handles_arbitrary_boundaries_and_ascii() {
        let mut decoder = Utf8ChunkDecoder::new();
        let mut out = String::new();
        out.push_str(&decoder.push(b"hello "));
        // break "文" (E6 96 87) after its first byte
        out.push_str(&decoder.push(&[0xE6]));
        out.push_str(&decoder.push(&[0x96, 0x87]));
        out.push_str(&decoder.push(b"!"));
        assert_eq!(out, "hello 文!");
        assert!(decoder.pending.is_empty());
    }

    #[test]
    fn utf8_decoder_replaces_invalid_bytes() {
        let mut decoder = Utf8ChunkDecoder::new();
        // 0xFF is never a valid UTF-8 start byte.
        let out = decoder.push(&[b'a', 0xFF, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
    }

    #[test]
    fn utf8_decoder_finish_flushes_tail_and_clears_pending() {
        let mut decoder = Utf8ChunkDecoder::new();
        assert_eq!(decoder.push(&[0xE4]), "");
        assert!(!decoder.pending.is_empty());
        let tail = decoder.finish();
        assert_eq!(tail, "\u{FFFD}", "incomplete tail becomes a replacement char");
        assert!(decoder.pending.is_empty());
        assert_eq!(decoder.finish(), "", "finish is idempotent once drained");
    }

    #[test]
    fn non_empty_secret_preserves_surrounding_spaces() {
        let value = "  secret  ".to_string();
        assert_eq!(non_empty_secret(Some(&value)), Some("  secret  "));
        let blank = "   ".to_string();
        assert_eq!(non_empty_secret(Some(&blank)), None);
        assert_eq!(non_empty_secret(None), None);
    }
}
