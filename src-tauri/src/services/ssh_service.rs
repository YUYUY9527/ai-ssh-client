use std::collections::HashMap;
use std::net::ToSocketAddrs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle};
use russh::keys::{decode_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, Pty};
use russh_sftp::client::{Config as SftpConfig, SftpSession};
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{app_error, AppError, AppResult};
use crate::models::settings::AppSettings;
use crate::models::ssh::{SftpFileInfo, SshConnection, SshEvent, SshSessionState};
use crate::services::sentinel::SentinelStripper;

enum SshControl {
    Input(String),
    Resize { cols: u32, rows: u32 },
    Shutdown,
}

const SFTP_REQUEST_TIMEOUT_SECS: u64 = 120;

struct SshSession {
    state: SshSessionState,
    control: mpsc::UnboundedSender<SshControl>,
    output_subscribers: Vec<mpsc::UnboundedSender<String>>,
}

/// Direction for an SFTP background transfer.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpTransferType {
    Upload,
    Download,
}

/// Completion payload emitted after an SFTP transfer finishes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferCompleteEvent {
    pub connection_id: String,
    pub task_id: String,
    pub filename: String,
    pub transfer_type: SftpTransferType,
    pub success: bool,
    pub error: Option<String>,
    pub local_path: Option<String>,
    pub remote_path: Option<String>,
}

#[derive(Clone)]
struct SshHandler;

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// SSH session registry and transport.
#[derive(Clone)]
pub struct SshService {
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
}

impl SshService {
    /// Creates an empty SSH service.
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Starts an interactive SSH shell and emits terminal output to the frontend.
    pub fn connect(
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
        self.insert_session(
            session_id.clone(),
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
        let setup_result = tauri::async_runtime::block_on(start_shell_task(
            app_handle,
            Arc::clone(&sessions),
            session_id.clone(),
            connection,
            cols,
            rows,
            settings,
            control_rx,
        ));

        if let Err(error) = setup_result {
            remove_session(&sessions, &session_id);
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
    pub fn test_connection(&self, connection: SshConnection) -> AppResult<()> {
        tauri::async_runtime::block_on(async {
            let session = connect_authenticated_session(&connection, None).await?;
            session
                .disconnect(Disconnect::ByApplication, "", "en")
                .await?;
            Ok::<(), crate::error::AppError>(())
        })?;
        Ok(())
    }

    /// Lists a remote directory through SFTP.
    pub async fn list_directory(
        &self,
        connection: SshConnection,
        remote_path: String,
    ) -> AppResult<Vec<SftpFileInfo>> {
        let (sftp, session) = open_sftp_session(&connection).await?;
        let entries = sftp.read_dir(remote_path.as_str()).await?;
        let mut files = Vec::new();

        for entry in entries {
            let filename = entry.file_name();
            let path = if remote_path == "/" {
                format!("/{filename}")
            } else {
                format!("{}/{}", remote_path.trim_end_matches('/'), filename)
            };
            let metadata = entry.metadata();
            files.push(SftpFileInfo {
                name: filename,
                path,
                size: metadata.len(),
                is_directory: metadata.is_dir(),
                is_symbolic_link: metadata.is_symlink(),
                mode: metadata
                    .permissions
                    .map(|mode| format!("{mode:o}"))
                    .unwrap_or_default(),
                mtime: metadata.mtime.map(|value| value as i64 * 1000).unwrap_or(0),
                atime: metadata.atime.map(|value| value as i64 * 1000).unwrap_or(0),
            });
        }

        files.sort_by(|left, right| {
            right
                .is_directory
                .cmp(&left.is_directory)
                .then_with(|| left.name.cmp(&right.name))
        });

        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        Ok(files)
    }

    /// Downloads a remote file through SFTP.
    pub async fn download_file(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
        local_path: String,
        task_id: String,
    ) -> AppResult<()> {
        let (sftp, session) = open_sftp_session(&connection).await?;
        let mut remote_file = sftp.open(remote_path.as_str()).await?;
        let total = remote_file.metadata().await?.len();
        let mut local_file = tokio::fs::File::create(&local_path).await?;
        let filename = Path::new(&remote_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
            .to_string();
        let mut transferred = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];

        loop {
            let read = remote_file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            local_file.write_all(&buffer[..read]).await?;
            transferred += read as u64;

            let progress = calculate_progress(transferred, total);
            let _ = app_handle.emit(
                "sftp-download-progress",
                json!({
                    "connectionId": connection.id,
                    "taskId": task_id,
                    "filename": filename,
                    "progress": progress,
                }),
            );
        }

        local_file.flush().await?;
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        emit_sftp_transfer_complete(
            &app_handle,
            SftpTransferCompleteEvent {
                connection_id: connection.id,
                task_id,
                filename,
                transfer_type: SftpTransferType::Download,
                success: true,
                error: None,
                local_path: Some(local_path),
                remote_path: Some(remote_path),
            },
        );
        Ok(())
    }

    /// Uploads a local file through SFTP and emits progress updates.
    pub async fn upload_file(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        local_path: String,
        remote_path: String,
        task_id: String,
    ) -> AppResult<()> {
        let (sftp, session) = open_sftp_session(&connection).await?;
        let filename = std::path::Path::new(&local_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("upload")
            .to_string();
        let total = tokio::fs::metadata(&local_path).await?.len();
        let mut local_file = tokio::fs::File::open(&local_path).await?;
        let mut remote_file = sftp
            .open_with_flags(
                remote_path.as_str(),
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
            )
            .await?;
        let mut transferred = 0_u64;
        let mut buffer = vec![0_u8; 64 * 1024];

        loop {
            let read = local_file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            remote_file.write_all(&buffer[..read]).await?;
            transferred += read as u64;

            let progress = calculate_progress(transferred, total);
            let _ = app_handle.emit(
                "sftp-upload-progress",
                json!({
                    "connectionId": connection.id,
                    "taskId": task_id,
                    "filename": filename,
                    "progress": progress,
                }),
            );
        }

        if let Err(err) = remote_file.flush().await {
            ensure_uploaded_after_close_error(&sftp, &remote_path, total, err).await?;
        }
        if let Err(err) = remote_file.shutdown().await {
            ensure_uploaded_after_close_error(&sftp, &remote_path, total, err).await?;
        }
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        emit_sftp_transfer_complete(
            &app_handle,
            SftpTransferCompleteEvent {
                connection_id: connection.id,
                task_id,
                filename,
                transfer_type: SftpTransferType::Upload,
                success: true,
                error: None,
                local_path: Some(local_path),
                remote_path: Some(remote_path),
            },
        );
        Ok(())
    }

    fn insert_session(
        &self,
        connection_id: String,
        state: SshSessionState,
        control: mpsc::UnboundedSender<SshControl>,
    ) -> AppResult<()> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| app_error("SSH 状态锁已损坏"))?;
        sessions.insert(
            connection_id,
            SshSession {
                state,
                control,
                output_subscribers: Vec::new(),
            },
        );
        Ok(())
    }
}

fn calculate_progress(transferred: u64, total: u64) -> u32 {
    if total == 0 {
        return 100;
    }

    ((transferred as f64 / total as f64) * 100.0)
        .round()
        .min(100.0) as u32
}

impl Default for SshService {
    fn default() -> Self {
        Self::new()
    }
}

async fn start_shell_task(
    app_handle: AppHandle,
    sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    session_id: String,
    connection: SshConnection,
    cols: u32,
    rows: u32,
    settings: Option<AppSettings>,
    mut control_rx: mpsc::UnboundedReceiver<SshControl>,
) -> AppResult<()> {
    let session = connect_authenticated_session(&connection, settings.as_ref()).await?;
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

    let state = SshSessionState {
        connection_id: session_id.clone(),
        is_connected: true,
        is_connecting: false,
        reconnect_attempts: 0,
        last_error: None,
    };
    emit_ssh_state(&app_handle, state.clone());
    update_session_state(&sessions, state);
    emit_ssh_data(&app_handle, &session_id, "\r\n".to_string());

    let task_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut visible_stripper = SentinelStripper::default();
        loop {
            tokio::select! {
                Some(control) = control_rx.recv() => {
                    match control {
                        SshControl::Input(input) => {
                            if let Err(error) = channel.data(input.as_bytes()).await {
                                emit_ssh_error(&app_handle, &task_session_id, &error.to_string());
                                break;
                            }
                        }
                        SshControl::Resize { cols, rows } => {
                            if let Err(error) = channel.window_change(cols, rows, 0, 0).await {
                                emit_ssh_error(&app_handle, &task_session_id, &error.to_string());
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
                            let text = String::from_utf8_lossy(&data).to_string();
                            broadcast_session_output(&sessions, &task_session_id, &text);
                            let visible_text = visible_stripper.feed(&text);
                            if !visible_text.is_empty() {
                                emit_ssh_data(&app_handle, &task_session_id, visible_text);
                            }
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let text = String::from_utf8_lossy(&data).to_string();
                            broadcast_session_output(&sessions, &task_session_id, &text);
                            emit_ssh_error(&app_handle, &task_session_id, &text);
                        }
                        Some(ChannelMsg::ExitStatus { .. }) | Some(ChannelMsg::Close) | None => {
                            break;
                        }
                        _ => {}
                    }
                }
            }
        }

        let visible_tail = visible_stripper.flush();
        if !visible_tail.is_empty() {
            emit_ssh_data(&app_handle, &task_session_id, visible_tail);
        }

        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        update_session_state(
            &sessions,
            SshSessionState {
                connection_id: task_session_id.clone(),
                is_connected: false,
                is_connecting: false,
                reconnect_attempts: 0,
                last_error: None,
            },
        );
        remove_session(&sessions, &task_session_id);
        let _ = app_handle.emit("ssh-close", task_session_id);
    });

    Ok(())
}

async fn connect_authenticated_session(
    connection: &SshConnection,
    settings: Option<&AppSettings>,
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

    let mut session = client::connect(Arc::new(config), addrs, SshHandler).await?;

    if let Some(password) = connection
        .password
        .as_ref()
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
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

async fn open_sftp_session(
    connection: &SshConnection,
) -> AppResult<(SftpSession, Handle<SshHandler>)> {
    let session = connect_authenticated_session(connection, None).await?;
    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let mut config = SftpConfig::default();
    config.request_timeout_secs = SFTP_REQUEST_TIMEOUT_SECS;
    let sftp = SftpSession::new_with_config(channel.into_stream(), config).await?;
    Ok((sftp, session))
}

async fn ensure_uploaded_after_close_error(
    sftp: &SftpSession,
    remote_path: &str,
    expected_size: u64,
    error: std::io::Error,
) -> AppResult<()> {
    if !error.to_string().eq_ignore_ascii_case("timeout") {
        return Err(error.into());
    }

    let metadata = sftp.metadata(remote_path).await?;
    if metadata.len() == expected_size {
        return Ok(());
    }

    Err(AppError::Io(error))
}

fn ensure_auth_success(auth: AuthResult) -> AppResult<()> {
    if auth.success() {
        Ok(())
    } else {
        Err(app_error("SSH 认证失败"))
    }
}

fn update_session_state(
    sessions: &Arc<Mutex<HashMap<String, SshSession>>>,
    state: SshSessionState,
) {
    if let Ok(mut guard) = sessions.lock() {
        if let Some(session) = guard.get_mut(&state.connection_id) {
            session.state = state;
        }
    }
}

fn remove_session(sessions: &Arc<Mutex<HashMap<String, SshSession>>>, connection_id: &str) {
    if let Ok(mut guard) = sessions.lock() {
        guard.remove(connection_id);
    }
}

fn broadcast_session_output(
    sessions: &Arc<Mutex<HashMap<String, SshSession>>>,
    connection_id: &str,
    data: &str,
) {
    if let Ok(mut guard) = sessions.lock() {
        if let Some(session) = guard.get_mut(connection_id) {
            session
                .output_subscribers
                .retain(|subscriber| subscriber.send(data.to_string()).is_ok());
        }
    }
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

/// Emits a terminal SFTP transfer event for foreground and background UI listeners.
pub fn emit_sftp_transfer_complete(app_handle: &AppHandle, event: SftpTransferCompleteEvent) {
    let _ = app_handle.emit("sftp-transfer-complete", event);
}
