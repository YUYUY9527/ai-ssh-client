use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::models::ai::{AiProviderConfig, Message};
use crate::models::ipc::{empty_success, error, success, IpcResult};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatOptions {
    request_id: Option<String>,
}

/// 向选定的 AI 提供商发送聊天请求
///
/// # 参数
/// * `state` - 应用状态
/// * `provider_id` - AI 提供商 ID
/// * `messages` - 消息历史列表
/// * `options` - 可选参数（包含请求 ID）
///
/// # 返回
/// 返回 AI 的响应内容
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

/// 启动流式 AI 请求，并通过 ai-chat-stream 事件返回增量内容。
#[tauri::command]
pub fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    messages: Vec<Message>,
    options: AiChatOptions,
) -> IpcResult<serde_json::Value> {
    let Some(request_id) = options.request_id else {
        return error("Missing AI request ID");
    };
    match state.ai.stream_chat(
        app,
        &state.storage,
        provider_id,
        messages,
        request_id.clone(),
    ) {
        Ok(()) => success(json!({ "requestId": request_id })),
        Err(err) => error(err.to_string()),
    }
}

/// 取消正在进行的 AI 请求
///
/// # 参数
/// * `state` - 应用状态
/// * `request_id` - 请求 ID
#[tauri::command]
pub fn ai_cancel_chat(state: State<'_, AppState>, request_id: String) -> IpcResult<()> {
    match state.ai.cancel_chat(&request_id) {
        Ok(_) => empty_success(),
        Err(err) => error(err.to_string()),
    }
}

/// 获取所有 AI 提供商配置
///
/// # 参数
/// * `state` - 应用状态
///
/// # 返回
/// 返回 AI 提供商列表（不包含 API 密钥）
#[tauri::command]
pub fn ai_get_providers(state: State<'_, AppState>) -> IpcResult<serde_json::Value> {
    match state.ai.get_providers(&state.storage) {
        Ok(providers) => success(json!({ "providers": providers })),
        Err(err) => error(err.to_string()),
    }
}

/// 保存 AI 提供商配置
///
/// # 参数
/// * `state` - 应用状态
/// * `provider` - AI 提供商配置
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

/// 测试 AI 提供商连接
///
/// 发送一个测试消息来验证 AI 提供商的配置是否正确
///
/// # 参数
/// * `state` - 应用状态
/// * `config` - AI 提供商配置
///
/// # 返回
/// 返回测试响应结果
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
