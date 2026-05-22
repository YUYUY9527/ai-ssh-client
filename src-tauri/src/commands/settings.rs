use serde_json::json;
use tauri::State;

use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::models::settings::{AppSettings, CommandHistoryItem, QuickCommand, QuickCommandGroup};
use crate::AppState;

/// Gets application settings.
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.storage.get_settings() {
        Ok(settings) => success(json!({ "settings": settings })),
        Err(err) => error(err.to_string()),
    }
}

/// Saves application settings.
#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> IpcResult<()> {
    match state.storage.save_settings(settings) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Shows a system notification. Native notification support is wired later.
#[tauri::command]
pub fn show_system_notification() -> IpcResult<()> {
    empty_success()
}

/// Gets command history.
#[tauri::command]
pub fn get_command_history(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.storage.get_command_history() {
        Ok(history) => success(json!({ "history": history })),
        Err(err) => error(err.to_string()),
    }
}

/// Adds a command history item.
#[tauri::command]
pub fn add_command_history(state: State<'_, AppState>, item: CommandHistoryItem) -> IpcResult<()> {
    match state.storage.add_command_history(item) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Clears command history.
#[tauri::command]
pub fn clear_command_history(state: State<'_, AppState>) -> IpcResult<()> {
    match state.storage.clear_command_history() {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Gets quick commands.
#[tauri::command]
pub fn get_quick_commands(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.storage.get_quick_commands() {
        Ok(commands) => success(json!({ "commands": commands })),
        Err(err) => error(err.to_string()),
    }
}

/// Saves a quick command.
#[tauri::command]
pub fn save_quick_command(state: State<'_, AppState>, command: QuickCommand) -> IpcResult<()> {
    match state.storage.save_quick_command(command) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Deletes a quick command.
#[tauri::command]
pub fn delete_quick_command(state: State<'_, AppState>, command_id: String) -> IpcResult<()> {
    match state.storage.delete_quick_command(&command_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Gets quick command groups.
#[tauri::command]
pub fn get_quick_command_groups(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.storage.get_quick_command_groups() {
        Ok(groups) => success(json!({ "groups": groups })),
        Err(err) => error(err.to_string()),
    }
}

/// Saves a quick command group.
#[tauri::command]
pub fn save_quick_command_group(
    state: State<'_, AppState>,
    group: QuickCommandGroup,
) -> IpcResult<()> {
    match state.storage.save_quick_command_group(group) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Deletes a quick command group.
#[tauri::command]
pub fn delete_quick_command_group(state: State<'_, AppState>, group_id: String) -> IpcResult<()> {
    match state.storage.delete_quick_command_group(&group_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}
