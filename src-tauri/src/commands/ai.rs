use serde::Deserialize;
use serde_json::json;
use tauri::State;

use crate::models::ai::{AiProviderConfig, Message};
use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatOptions {
    request_id: Option<String>,
}

/// Sends a chat request to the selected AI provider.
#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    provider_id: String,
    messages: Vec<Message>,
    options: Option<AiChatOptions>,
) -> Result<IpcResult<serde_json::Value>, String> {
    let request_id = options.and_then(|value| value.request_id);
    Ok(
        match state
            .ai
            .chat(&state.storage, provider_id, messages, request_id)
            .await
        {
            Ok(response) => success(json!(response)),
            Err(err) => error(err.to_string()),
        },
    )
}

/// Cancels an active AI request.
#[tauri::command]
pub fn ai_cancel_chat(state: State<'_, AppState>, request_id: String) -> IpcResult<()> {
    match state.ai.cancel_chat(&request_id) {
        Ok(_) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Gets AI providers.
#[tauri::command]
pub fn ai_get_providers(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.ai.get_providers(&state.storage) {
        Ok(providers) => success(json!({ "providers": providers })),
        Err(err) => error(err.to_string()),
    }
}

/// Saves an AI provider.
#[tauri::command]
pub fn ai_save_provider(state: State<'_, AppState>, provider: AiProviderConfig) -> IpcResult<()> {
    match state.ai.save_provider(&state.storage, provider) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Deletes an AI provider.
#[tauri::command]
pub fn ai_delete_provider(state: State<'_, AppState>, provider_id: String) -> IpcResult<()> {
    match state.ai.delete_provider(&state.storage, &provider_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Sets the active AI provider.
#[tauri::command]
pub fn ai_set_active_provider(state: State<'_, AppState>, provider_id: String) -> IpcResult<()> {
    match state.ai.set_active_provider(&state.storage, &provider_id) {
        Ok(()) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// Tests an AI provider.
#[tauri::command]
pub async fn ai_test_provider(
    state: State<'_, AppState>,
    mut config: AiProviderConfig,
) -> Result<IpcResult<serde_json::Value>, String> {
    if config
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        config.api_key = state.storage.get_ai_providers().ok().and_then(|providers| {
            providers
                .into_iter()
                .find(|provider| provider.id == config.id)
                .and_then(|provider| provider.api_key)
        });
    }

    Ok(match state.ai.test_provider(config).await {
        Ok(response) => success(json!(response)),
        Err(err) => error(err.to_string()),
    })
}

/// Gets AI provider secret status.
#[tauri::command]
pub fn ai_get_provider_secret_status(
    state: State<'_, AppState>,
    provider_id: String,
) -> IpcResult<serde_json::Value> {
    match state
        .ai
        .get_provider_secret_status(&state.storage, &provider_id)
    {
        Ok(status) => success(json!(status)),
        Err(err) => error(err.to_string()),
    }
}
