use serde_json::json;

use tauri::{AppHandle, State};

use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::models::settings::AppSettings;
use crate::models::sftp::{
    SftpResolveConflictRequest, SftpStartDownloadRequest, SftpStartUploadRequest,
    SftpTransferTaskRequest,
};
use crate::models::ssh::{HostTrustRecord, SshConnectResult, SshConnection};
use crate::AppState;

/// 启动 SSH 会话
///
/// 建立到远程服务器的 SSH 连接，并打开一个交互式终端
///
/// # 参数
/// * `app_handle` - Tauri 应用句柄
/// * `state` - 应用状态
/// * `connection` - SSH 连接配置
/// * `cols` - 终端列数（可选，默认 80）
/// * `rows` - 终端行数（可选，默认 24）
/// * `settings` - 应用设置（可选）
///
/// # 返回
/// 返回包含会话 ID 的连接结果
#[tauri::command]
pub async fn ssh_connect(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection: SshConnection,
    cols: Option<u32>,
    rows: Option<u32>,
    settings: Option<AppSettings>,
) -> Result<IpcResult<SshConnectResult>, String> {
    Ok(
        match state
            .ssh
            .connect(
                app_handle,
                connection,
                cols.unwrap_or(80),
                rows.unwrap_or(24),
                settings,
            )
            .await
        {
            Ok(session_id) => success(SshConnectResult { session_id }),
            Err(err) => error(err.to_string()),
        },
    )
}

/// 断开 SSH 会话
///
/// # 参数
/// * `state` - 应用状态
/// * `connection_id` - SSH 连接 ID
#[tauri::command]
pub fn ssh_disconnect(state: State<'_, AppState>, connection_id: String) -> IpcResult<()> {
    match state.ssh.disconnect(&connection_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// 向 SSH 会话发送终端输入
///
/// 将用户输入的命令或文本发送到远程终端
///
/// # 参数
/// * `state` - 应用状态
/// * `connection_id` - SSH 连接 ID
/// * `command` - 要执行的命令或输入的文本
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

/// 测试 SSH 连接
///
/// 尝试连接到远程服务器以验证连接配置是否正确
///
/// # 参数
/// * `app_handle` - Tauri 应用句柄（用于主机指纹确认弹窗）
/// * `state` - 应用状态
/// * `connection` - SSH 连接配置
#[tauri::command]
pub async fn ssh_test_connection(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection: SshConnection,
) -> Result<IpcResult<()>, String> {
    Ok(
        match state.ssh.test_connection(app_handle, connection).await {
            Ok(()) => empty_success(),
            Err(err) => error(err.to_string()),
        },
    )
}

fn resolve_sftp_connection(
    state: &AppState,
    connection_id: &str,
) -> crate::error::AppResult<Option<SshConnection>> {
    match state.ssh.runtime_connection(connection_id)? {
        Some(connection) => Ok(Some(connection)),
        None => state.storage.get_connection(connection_id),
    }
}

/// 调整远程终端大小
///
/// 当前端终端窗口大小变化时，同步调整远程终端的尺寸
///
/// # 参数
/// * `state` - 应用状态
/// * `connection_id` - SSH 连接 ID
/// * `cols` - 新的列数
/// * `rows` - 新的行数
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

/// Looks up a trusted host fingerprint record.
#[tauri::command]
pub fn ssh_get_host_trust_record(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> IpcResult<serde_json::Value> {
    match state.storage.get_host_trust_record(&host, port) {
        Ok(record) => success(json!({
            "host": host,
            "port": port,
            "record": record,
        })),
        Err(err) => error(err.to_string()),
    }
}

/// Lists all trusted host fingerprint records.
#[tauri::command]
pub fn ssh_list_host_trust_records(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.storage.list_host_trust_records() {
        Ok(records) => success(json!({ "records": records })),
        Err(err) => error(err.to_string()),
    }
}

/// Upserts a trusted host fingerprint record.
#[tauri::command]
pub fn ssh_upsert_host_trust_record(
    state: State<'_, AppState>,
    record: HostTrustRecord,
) -> IpcResult<()> {
    match state.storage.upsert_host_trust_record(record) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Deletes a trusted host fingerprint record.
#[tauri::command]
pub fn ssh_delete_host_trust_record(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> IpcResult<()> {
    match state.storage.delete_host_trust_record(&host, port) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Clears all trusted host fingerprint records.
#[tauri::command]
pub fn ssh_clear_host_trust_records(state: State<'_, AppState>) -> IpcResult<()> {
    match state.storage.clear_host_trust_records() {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// 响应主机指纹确认弹窗（接受 / 拒绝）。
#[tauri::command]
pub fn ssh_respond_host_trust(
    state: State<'_, AppState>,
    request_id: String,
    accepted: bool,
) -> IpcResult<()> {
    match state.ssh.respond_host_trust(&request_id, accepted) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// 通过 SFTP 列出远程目录内容
///
/// # 参数
/// * `state` - 应用状态
/// * `connection_id` - SSH 连接 ID
/// * `remote_path` - 远程目录路径
///
/// # 返回
/// 返回目录中的文件和子目录列表
#[tauri::command]
pub async fn sftp_list_directory(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
) -> Result<IpcResult<serde_json::Value>, String> {
    let connection = match resolve_sftp_connection(state.inner(), &connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };

    Ok(
        match state
            .ssh
            .list_directory(
                app_handle,
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

#[tauri::command]
pub async fn sftp_rename_item(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
    new_name: String,
) -> Result<IpcResult<()>, String> {
    let connection = match resolve_sftp_connection(state.inner(), &connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };

    Ok(
        match state
            .ssh
            .rename_item(app_handle, connection, remote_path, new_name)
            .await
        {
            Ok(()) => empty_success(),
            Err(err) => error(err.to_string()),
        },
    )
}

#[tauri::command]
pub async fn sftp_delete_item(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
) -> Result<IpcResult<()>, String> {
    let connection = match resolve_sftp_connection(state.inner(), &connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };

    Ok(
        match state
            .ssh
            .delete_item(app_handle, connection, remote_path)
            .await
        {
            Ok(()) => empty_success(),
            Err(err) => error(err.to_string()),
        },
    )
}

/// Creates one remote SFTP directory.
#[tauri::command]
pub async fn sftp_create_directory(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
) -> Result<IpcResult<()>, String> {
    let connection = match resolve_sftp_connection(state.inner(), &connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };
    Ok(
        match state
            .sftp
            .create_directory(app_handle, connection, remote_path)
            .await
        {
            Ok(()) => empty_success(),
            Err(err) => error(err.to_string()),
        },
    )
}

/// Deletes a group of remote SFTP items and returns every item result.
#[tauri::command]
pub async fn sftp_delete_items(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    remote_paths: Vec<String>,
) -> Result<IpcResult<crate::models::sftp::SftpBatchDeleteResult>, String> {
    let connection = match resolve_sftp_connection(state.inner(), &connection_id) {
        Ok(Some(connection)) => connection,
        Ok(None) => return Ok(error("Connection not found")),
        Err(err) => return Ok(error(err.to_string())),
    };
    Ok(success(
        state
            .sftp
            .delete_items(app_handle, connection, remote_paths)
            .await,
    ))
}

/// Registers and starts desktop upload tasks.
#[tauri::command]
pub fn sftp_start_upload(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    request: SftpStartUploadRequest,
) -> IpcResult<crate::models::sftp::SftpStartTransferResult> {
    match state.sftp.start_upload(app_handle, request) {
        Ok(result) => success(result),
        Err(err) => error(err.to_string()),
    }
}

/// Registers and starts desktop download tasks.
#[tauri::command]
pub fn sftp_start_download(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    request: SftpStartDownloadRequest,
) -> IpcResult<crate::models::sftp::SftpStartTransferResult> {
    match state.sftp.start_download(app_handle, request) {
        Ok(result) => success(result),
        Err(err) => error(err.to_string()),
    }
}

/// Applies a selected conflict policy to a waiting task.
#[tauri::command]
pub fn sftp_resolve_conflict(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    request: SftpResolveConflictRequest,
) -> IpcResult<()> {
    match state.sftp.resolve_conflict(app_handle, request) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Requests cancellation for a desktop SFTP task.
#[tauri::command]
pub fn sftp_cancel_transfer(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    request: SftpTransferTaskRequest,
) -> IpcResult<()> {
    match state.sftp.cancel(&app_handle, request) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Requeues a terminal desktop SFTP task.
#[tauri::command]
pub fn sftp_retry_transfer(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    request: SftpTransferTaskRequest,
) -> IpcResult<crate::models::sftp::SftpTransferTaskSnapshot> {
    match state.sftp.retry(app_handle, request) {
        Ok(snapshot) => success(snapshot),
        Err(err) => error(err.to_string()),
    }
}

/// Removes a terminal desktop SFTP task record.
#[tauri::command]
pub fn sftp_discard_transfer(
    state: State<'_, AppState>,
    request: SftpTransferTaskRequest,
) -> IpcResult<()> {
    match state.sftp.discard(request) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Lists desktop SFTP tasks, optionally scoped to one connection.
#[tauri::command]
pub fn sftp_list_transfers(
    state: State<'_, AppState>,
    connection_id: Option<String>,
) -> IpcResult<crate::models::sftp::SftpListTransfersResult> {
    match state.sftp.list(connection_id.as_deref()) {
        Ok(result) => success(result),
        Err(err) => error(err.to_string()),
    }
}
