use serde_json::json;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::models::settings::AppSettings;
use crate::models::ssh::{HostTrustRecord, SshConnectResult, SshConnection};
use crate::services::ssh_service::{
    emit_sftp_transfer_complete, SftpTransferCompleteEvent, SftpTransferType,
};
use crate::AppState;

/// Starts an SSH session.
#[tauri::command]
pub fn ssh_connect(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection: SshConnection,
    cols: Option<u32>,
    rows: Option<u32>,
    settings: Option<AppSettings>,
) -> IpcResult<SshConnectResult> {
    match state.ssh.connect(
        app_handle,
        connection,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        settings,
    ) {
        Ok(session_id) => success(SshConnectResult { session_id }),
        Err(err) => error(err.to_string()),
    }
}

/// Disconnects an SSH session.
#[tauri::command]
pub fn ssh_disconnect(state: State<'_, AppState>, connection_id: String) -> IpcResult<()> {
    match state.ssh.disconnect(&connection_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Sends terminal input to an SSH session.
#[tauri::command]
pub fn ssh_execute(
    state: State<'_, AppState>,
    connection_id: String,
    command: String,
) -> IpcResult<()> {
    match state.ssh.execute(&connection_id, command) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Sends terminal input without awaiting a result.
#[tauri::command]
pub fn ssh_execute_sync(
    state: State<'_, AppState>,
    connection_id: String,
    command: String,
) -> IpcResult<()> {
    match state.ssh.execute(&connection_id, command) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Gets SSH session states.
#[tauri::command]
pub fn ssh_get_sessions(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.ssh.get_session_states() {
        Ok(sessions) => success(json!({ "sessions": sessions })),
        Err(err) => error(err.to_string()),
    }
}

/// Tests an SSH connection.
#[tauri::command]
pub fn ssh_test_connection(state: State<'_, AppState>, connection: SshConnection) -> IpcResult<()> {
    match state.ssh.test_connection(connection) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Resizes a remote terminal.
#[tauri::command]
pub fn ssh_resize(
    state: State<'_, AppState>,
    connection_id: String,
    cols: u32,
    rows: u32,
) -> IpcResult<()> {
    match state.ssh.resize(&connection_id, cols, rows) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Reserved host trust lookup for future SSH fingerprint verification flows.
#[tauri::command]
pub fn ssh_get_host_trust_record(
    _state: State<'_, AppState>,
    host: String,
    port: u16,
) -> IpcResult<serde_json::Value> {
    let record: Option<HostTrustRecord> = None;
    success(json!({
        "host": host,
        "port": port,
        "record": record,
    }))
}

/// Lists a remote directory through SFTP.
#[tauri::command]
pub async fn sftp_list_directory(
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
) -> Result<IpcResult<serde_json::Value>, String> {
    let connection = match state.storage.get_connection(&connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };

    Ok(
        match state
            .ssh
            .list_directory(
                connection,
                if remote_path.trim().is_empty() {
                    "/".to_string()
                } else {
                    remote_path
                },
            )
            .await
        {
            Ok(files) => success(json!({ "files": files })),
            Err(err) => error(err.to_string()),
        },
    )
}

/// Downloads a remote file through SFTP.
#[tauri::command]
pub async fn sftp_download_file(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
    task_id: Option<String>,
) -> Result<IpcResult<serde_json::Value>, String> {
    let connection = match state.storage.get_connection(&connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };
    let filename = Path::new(&remote_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let selected_path = app_handle
        .dialog()
        .file()
        .set_file_name(filename)
        .blocking_save_file();

    let Some(selected_path) = selected_path else {
        return Ok(error("Cancelled"));
    };
    let local_path_string = PathBuf::try_from(selected_path)
        .map_err(|err| err.to_string())?
        .to_string_lossy()
        .to_string();
    let task_id = task_id.unwrap_or_default();
    let service = state.ssh.clone();
    let background_app_handle = app_handle.clone();
    let background_connection = connection.clone();
    let background_remote_path = remote_path.clone();
    let background_local_path = local_path_string.clone();
    let background_task_id = task_id.clone();
    let background_filename = filename.to_string();

    tauri::async_runtime::spawn(async move {
        if let Err(err) = service
            .download_file(
                background_app_handle.clone(),
                background_connection.clone(),
                background_remote_path.clone(),
                background_local_path.clone(),
                background_task_id.clone(),
            )
            .await
        {
            emit_sftp_transfer_complete(
                &background_app_handle,
                SftpTransferCompleteEvent {
                    connection_id: background_connection.id,
                    task_id: background_task_id,
                    filename: background_filename,
                    transfer_type: SftpTransferType::Download,
                    success: false,
                    error: Some(err.to_string()),
                    local_path: Some(background_local_path),
                    remote_path: Some(background_remote_path),
                },
            );
        }
    });

    Ok(success(json!({ "localPath": local_path_string })))
}

/// Uploads a local file through SFTP.
#[tauri::command]
pub async fn sftp_upload_file(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    mut local_path: String,
    remote_dir: String,
    task_id: Option<String>,
) -> Result<IpcResult<serde_json::Value>, String> {
    if local_path.trim().is_empty() {
        let selected_path = app_handle
            .dialog()
            .file()
            .set_title("选择上传文件")
            .blocking_pick_file();

        let Some(selected_path) = selected_path else {
            return Ok(error("Cancelled"));
        };
        local_path = PathBuf::try_from(selected_path)
            .map_err(|err| err.to_string())?
            .to_string_lossy()
            .to_string();
    }

    let connection = match state.storage.get_connection(&connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };
    let filename = Path::new(&local_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("upload");
    let remote_path = if remote_dir == "/" {
        format!("/{filename}")
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), filename)
    };

    let task_id = task_id.unwrap_or_default();
    let service = state.ssh.clone();
    let background_app_handle = app_handle.clone();
    let background_connection = connection.clone();
    let background_local_path = local_path.clone();
    let background_remote_path = remote_path.clone();
    let background_task_id = task_id.clone();
    let background_filename = filename.to_string();

    tauri::async_runtime::spawn(async move {
        if let Err(err) = service
            .upload_file(
                background_app_handle.clone(),
                background_connection.clone(),
                background_local_path.clone(),
                background_remote_path.clone(),
                background_task_id.clone(),
            )
            .await
        {
            emit_sftp_transfer_complete(
                &background_app_handle,
                SftpTransferCompleteEvent {
                    connection_id: background_connection.id,
                    task_id: background_task_id,
                    filename: background_filename,
                    transfer_type: SftpTransferType::Upload,
                    success: false,
                    error: Some(err.to_string()),
                    local_path: Some(background_local_path),
                    remote_path: Some(background_remote_path),
                },
            );
        }
    });

    Ok(success(json!({ "remotePath": remote_path })))
}
