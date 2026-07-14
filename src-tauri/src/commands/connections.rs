use serde::Deserialize;
use serde_json::json;
use tauri::State;

use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::models::ssh::SshConnection;
use crate::AppState;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDataOptions {
    /// When false, password/private key/api key are stripped.
    pub include_secrets: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDataOptions {
    /// When true (default), upsert by id; when false, replace related collections.
    pub merge: Option<bool>,
}

/// Gets saved SSH connections.
#[tauri::command]
pub fn get_connections(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.storage.get_connections() {
        Ok(connections) => success(json!({ "connections": connections })),
        Err(err) => error(err.to_string()),
    }
}

/// Saves an SSH connection.
#[tauri::command]
pub fn save_connection(state: State<'_, AppState>, connection: SshConnection) -> IpcResult<()> {
    match state.storage.save_connection(connection) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Deletes an SSH connection.
#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, connection_id: String) -> IpcResult<()> {
    match state.storage.delete_connection(&connection_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Reorders saved SSH connections.
#[tauri::command]
pub fn reorder_connections(
    state: State<'_, AppState>,
    connection_ids: Vec<String>,
) -> IpcResult<()> {
    match state.storage.reorder_connections(connection_ids) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Exports persisted user data (connections, providers, settings, history...).
#[tauri::command]
pub fn export_all_data(
    state: State<'_, AppState>,
    options: Option<ExportDataOptions>,
) -> IpcResult<serde_json::Value> {
    let include_secrets = options
        .and_then(|value| value.include_secrets)
        .unwrap_or(true);
    match state.storage.export_all_data(include_secrets) {
        Ok(data) => success(json!({ "data": data })),
        Err(err) => error(err.to_string()),
    }
}

/// Imports a backup payload; merge defaults to true.
#[tauri::command]
pub fn import_data(
    state: State<'_, AppState>,
    data: serde_json::Value,
    options: Option<ImportDataOptions>,
) -> IpcResult<serde_json::Value> {
    let merge = options.and_then(|value| value.merge).unwrap_or(true);
    match state.storage.import_all_data(data, merge) {
        Ok(summary) => success(json!({
            "imported": {
                "connections": summary.connections,
                "aiProviders": summary.ai_providers,
                "settings": summary.settings,
                "quickCommands": summary.quick_commands,
                "quickCommandGroups": summary.quick_command_groups,
                "commandHistory": summary.command_history,
            },
            "skipped": summary.skipped,
        })),
        Err(err) => error(err.to_string()),
    }
}
