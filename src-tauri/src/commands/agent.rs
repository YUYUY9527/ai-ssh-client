use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::services::agent_service::default_exec_timeout_ms;
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExecOptions {
    run_id: Option<String>,
    timeout_ms: Option<u64>,
}

/// Starts an agent task.
#[tauri::command]
pub fn agent_start_task(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    connection_id: String,
) -> IpcResult<()> {
    match state
        .agent
        .start_task(app_handle, &state.ssh, task_id, connection_id)
    {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Stops an agent task.
#[tauri::command]
pub fn agent_stop_task(state: State<'_, AppState>, connection_id: String) -> IpcResult<()> {
    match state.agent.stop_task(&connection_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Pauses an agent task.
#[tauri::command]
pub fn agent_pause_task(state: State<'_, AppState>) -> IpcResult<()> {
    match state.agent.cancel_all_execs() {
        Ok(_) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Resumes an agent task.
#[tauri::command]
pub fn agent_resume_task() -> IpcResult<()> {
    empty_success()
}

/// Executes a command and waits for a sentinel.
#[tauri::command]
pub async fn agent_exec_await(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    command: String,
    options: Option<AgentExecOptions>,
) -> Result<IpcResult<serde_json::Value>, String> {
    let run_id = options
        .as_ref()
        .and_then(|value| value.run_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let timeout_ms = default_exec_timeout_ms(options.and_then(|value| value.timeout_ms));

    Ok(
        match state
            .agent
            .exec_await(
                app_handle,
                &state.ssh,
                connection_id,
                command,
                run_id,
                timeout_ms,
            )
            .await
        {
            Ok(result) => success(json!(result)),
            Err(err) => error(err.to_string()),
        },
    )
}

/// Cancels a pending agent execution.
#[tauri::command]
pub fn agent_cancel_exec(state: State<'_, AppState>, connection_id: String) -> IpcResult<()> {
    match state.agent.cancel_exec(&connection_id) {
        Ok(_) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Gets agent task history.
#[tauri::command]
pub fn agent_get_task_history(state: State<'_, AppState>) -> IpcResult<Value> {
    match state.agent_history.list_tasks(30) {
        Ok(tasks) => success(json!({ "tasks": tasks })),
        Err(err) => error(err.to_string()),
    }
}

/// Saves an agent task into SQLite history.
#[tauri::command]
pub fn agent_save_task_history(state: State<'_, AppState>, task: Value) -> IpcResult<()> {
    match state.agent_history.save_task(task) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Clears all agent task history.
#[tauri::command]
pub fn agent_clear_task_history(state: State<'_, AppState>) -> IpcResult<()> {
    match state.agent_history.clear_tasks() {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Deletes one agent task history record.
#[tauri::command]
pub fn agent_delete_task_history(state: State<'_, AppState>, task_id: String) -> IpcResult<()> {
    match state.agent_history.delete_task(&task_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}
