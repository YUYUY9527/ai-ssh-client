use serde_json::json;
use tauri::State;

use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::models::ssh::SshConnection;
use crate::AppState;

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

/// Exports all persisted user data. Full schema is added during storage migration.
#[tauri::command]
pub fn export_all_data() -> IpcResult<serde_json::Value> {
    success(json!({
        "data": {
            "version": "tauri-migration-0",
            "connections": [],
            "aiProviders": [],
            "settings": {},
            "commandHistory": [],
            "quickCommands": [],
            "quickCommandGroups": []
        }
    }))
}

/// Imports user data. Full schema validation is added during storage migration.
#[tauri::command]
pub fn import_data() -> IpcResult<serde_json::Value> {
    success(json!({
        "imported": {
            "connections": 0,
            "aiProviders": 0,
            "settings": 0,
            "quickCommands": 0,
            "quickCommandGroups": 0
        },
        "skipped": []
    }))
}
