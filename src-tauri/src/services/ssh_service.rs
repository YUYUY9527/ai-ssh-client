use std::collections::HashMap;
use std::net::ToSocketAddrs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use russh::client::{self, AuthResult, Handle};
use russh::keys::{decode_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect, Pty};
use russh_sftp::client::{error::Error as SftpError, Config as SftpConfig, SftpSession};
use russh_sftp::protocol::{OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::error::{app_error, AppError, AppResult};
use crate::models::settings::AppSettings;
use crate::models::ssh::{
    HostTrustPromptEvent, HostTrustPromptKind, HostTrustRecord, SftpFileInfo, SshConnection,
    SshEvent, SshSessionState,
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

type PendingTrustMap = Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>;

#[derive(Clone)]
struct SshHandler {
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
}

impl SshService {
    /// Creates an SSH service bound to the shared storage layer.
    pub fn new(storage: Arc<StorageService>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            storage,
            pending_trust: Arc::new(Mutex::new(HashMap::new())),
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
        self.insert_session(
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
            connection,
            cols,
            rows,
            settings,
            control_rx,
        )
        .await;

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

    /// Lists a remote directory through SFTP.
    pub async fn list_directory(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
    ) -> AppResult<Vec<SftpFileInfo>> {
        let (sftp, session) = open_sftp_session(
            &connection,
            Arc::clone(&self.storage),
            app_handle,
            Arc::clone(&self.pending_trust),
        )
        .await?;
        let protocol_path = sftp_protocol_path(&remote_path);
        let entries = sftp.read_dir(protocol_path.as_str()).await?;
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
        let (sftp, session) = open_sftp_session(
            &connection,
            Arc::clone(&self.storage),
            app_handle.clone(),
            Arc::clone(&self.pending_trust),
        )
        .await?;
        let protocol_path = sftp_protocol_path(&remote_path);
        let mut remote_file = sftp.open(protocol_path.as_str()).await?;
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
        let (sftp, session) = open_sftp_session(
            &connection,
            Arc::clone(&self.storage),
            app_handle.clone(),
            Arc::clone(&self.pending_trust),
        )
        .await?;
        let filename = std::path::Path::new(&local_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("upload")
            .to_string();
        let total = tokio::fs::metadata(&local_path).await?.len();
        let mut local_file = tokio::fs::File::open(&local_path).await?;
        let protocol_path = sftp_protocol_path(&remote_path);
        let mut remote_file = sftp
            .open_with_flags(
                protocol_path.as_str(),
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
            ensure_uploaded_after_close_error(&sftp, &protocol_path, total, err).await?;
        }
        if let Err(err) = remote_file.shutdown().await {
            ensure_uploaded_after_close_error(&sftp, &protocol_path, total, err).await?;
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

    /// Renames a remote item without replacing an existing sibling.
    pub async fn rename_item(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
        new_name: String,
    ) -> AppResult<()> {
        let destination = sftp_sibling_path(&remote_path, &new_name)?;
        let (sftp, session) = open_sftp_session(
            &connection,
            Arc::clone(&self.storage),
            app_handle,
            Arc::clone(&self.pending_trust),
        )
        .await?;
        let source = sftp_protocol_path(&remote_path);
        let destination = sftp_protocol_path(&destination);

        match sftp.symlink_metadata(destination.as_str()).await {
            Ok(_) => return Err(app_error("Destination already exists")),
            Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {}
            Err(error) => return Err(error.into()),
        }

        sftp.rename(source, destination).await?;
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        Ok(())
    }

    /// Deletes a remote file, symlink, or directory tree without following symlinks.
    pub async fn delete_item(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
    ) -> AppResult<()> {
        validate_sftp_item_path(&remote_path)?;
        let (sftp, session) = open_sftp_session(
            &connection,
            Arc::clone(&self.storage),
            app_handle,
            Arc::clone(&self.pending_trust),
        )
        .await?;
        let mut stack = vec![(sftp_protocol_path(&remote_path), false)];

        while let Some((path, visited)) = stack.pop() {
            if visited {
                sftp.remove_dir(path).await?;
                continue;
            }

            let metadata = sftp.symlink_metadata(path.as_str()).await?;
            if !metadata.is_dir() || metadata.is_symlink() {
                sftp.remove_file(path).await?;
                continue;
            }

            let entries = sftp.read_dir(path.as_str()).await?;
            stack.push((path.clone(), true));
            let mut children = entries
                .into_iter()
                .map(|entry| entry.file_name())
                .filter(|name| name != "." && name != "..")
                .collect::<Vec<_>>();
            children.reverse();
            for name in children {
                stack.push((sftp_child_path(&path, &name), false));
            }
        }

        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        Ok(())
    }

    fn insert_session(
        &self,
        connection_id: String,
        connection: SshConnection,
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
                connection,
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

fn sftp_protocol_path(path: &str) -> String {
    if path == "~" {
        ".".to_string()
    } else if let Some(relative) = path.strip_prefix("~/") {
        format!("./{relative}")
    } else {
        path.to_string()
    }
}

fn validate_sftp_item_name(name: &str) -> AppResult<()> {
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

fn validate_sftp_item_path(path: &str) -> AppResult<()> {
    let trimmed = path.trim();
    let compact = trimmed.trim_end_matches('/');
    let absolute_depth = trimmed.strip_prefix('/').map(|relative| {
        relative.split('/').fold(0_usize, |depth, part| match part {
            "" | "." => depth,
            ".." => depth.saturating_sub(1),
            _ => depth + 1,
        })
    });
    if compact.is_empty()
        || matches!(compact, "." | "~")
        || absolute_depth.is_some_and(|depth| depth == 0)
    {
        return Err(app_error("Protected SFTP path"));
    }
    Ok(())
}

fn sftp_sibling_path(remote_path: &str, new_name: &str) -> AppResult<String> {
    validate_sftp_item_path(remote_path)?;
    validate_sftp_item_name(new_name)?;
    let source = remote_path.trim_end_matches('/');
    Ok(match source.rsplit_once('/') {
        Some(("", _)) => format!("/{new_name}"),
        Some((parent, _)) => format!("{parent}/{new_name}"),
        None => new_name.to_string(),
    })
}

fn sftp_child_path(parent: &str, name: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::{
        sftp_child_path, sftp_protocol_path, sftp_sibling_path, validate_sftp_item_name,
        validate_sftp_item_path,
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

        for path in ["", "/", "//", "/./", "/tmp/..", ".", "~", "~/"] {
            assert!(validate_sftp_item_path(path).is_err());
        }
        assert!(validate_sftp_item_path("~/project").is_ok());
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
}
