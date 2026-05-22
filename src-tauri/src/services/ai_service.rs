use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

use crate::error::{app_error, AppResult};
use crate::models::ai::{AiChatResponse, AiProviderConfig, AiProviderSummary, AiUsage, Message};
use crate::services::storage_service::StorageService;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RETRIES: usize = 1;

/// AI provider transport and cancellation registry.
pub struct AiService {
    client: reqwest::Client,
    active_requests: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

impl AiService {
    /// Creates an AI service with a shared HTTP client.
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            active_requests: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Returns provider summaries without API keys.
    pub fn get_providers(&self, storage: &StorageService) -> AppResult<Vec<AiProviderSummary>> {
        Ok(storage
            .get_ai_providers()?
            .into_iter()
            .map(provider_to_summary)
            .collect())
    }

    /// Saves a provider through storage.
    pub fn save_provider(
        &self,
        storage: &StorageService,
        provider: AiProviderConfig,
    ) -> AppResult<()> {
        storage.save_ai_provider(provider)
    }

    /// Deletes a provider through storage.
    pub fn delete_provider(&self, storage: &StorageService, provider_id: &str) -> AppResult<()> {
        storage.delete_ai_provider(provider_id)
    }

    /// Sets the active provider through storage.
    pub fn set_active_provider(
        &self,
        storage: &StorageService,
        provider_id: &str,
    ) -> AppResult<()> {
        storage.set_active_ai_provider(provider_id)
    }

    /// Gets API key status for a provider.
    pub fn get_provider_secret_status(
        &self,
        storage: &StorageService,
        provider_id: &str,
    ) -> AppResult<AiProviderSecretStatus> {
        let (has_api_key, masked_api_key) = storage.get_ai_provider_secret_status(provider_id)?;
        Ok(AiProviderSecretStatus {
            provider_id: provider_id.to_string(),
            has_api_key,
            masked_api_key,
        })
    }

    /// Sends a chat request to an active provider.
    pub async fn chat(
        &self,
        storage: &StorageService,
        provider_id: String,
        messages: Vec<Message>,
        request_id: Option<String>,
    ) -> AppResult<AiChatResponse> {
        let provider = storage
            .get_ai_providers()?
            .into_iter()
            .find(|provider| provider.id == provider_id && provider.is_active)
            .ok_or_else(|| app_error(format!("Provider {provider_id} not found or not active")))?;

        self.chat_with_provider(provider, messages, request_id)
            .await
    }

    /// Sends a small test message to a provider config.
    pub async fn test_provider(&self, config: AiProviderConfig) -> AppResult<AiChatResponse> {
        self.chat_with_provider(
            config,
            vec![Message {
                id: "test".to_string(),
                role: "user".to_string(),
                content: "你好，请回复“连接成功”".to_string(),
                timestamp: 0,
            }],
            Some(format!("test-{}", uuid::Uuid::new_v4())),
        )
        .await
    }

    /// Cancels an active request by request id.
    pub fn cancel_chat(&self, request_id: &str) -> AppResult<bool> {
        let mut active_requests = self
            .active_requests
            .lock()
            .map_err(|_| app_error("AI 请求状态锁已损坏"))?;

        Ok(active_requests
            .remove(request_id)
            .map(|cancel| cancel.send(()).is_ok())
            .unwrap_or(false))
    }

    async fn chat_with_provider(
        &self,
        provider: AiProviderConfig,
        messages: Vec<Message>,
        request_id: Option<String>,
    ) -> AppResult<AiChatResponse> {
        validate_provider(&provider)?;

        let request_id =
            request_id.unwrap_or_else(|| format!("{}-{}", provider.id, uuid::Uuid::new_v4()));
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        self.register_request(request_id.clone(), cancel_tx)?;

        let result = async {
            let mut last_error = None;
            for attempt in 0..=MAX_RETRIES {
                let response = tokio::select! {
                    response = self.send_openai_compatible_request(&provider, &messages, &request_id) => response,
                    _ = &mut cancel_rx => return Err(app_error("用户取消了 AI 请求")),
                };

                match response {
                    Ok(response) => return Ok(response),
                    Err(error) => {
                        let retryable = is_retryable_error(&error);
                        last_error = Some(error);
                        if !retryable || attempt >= MAX_RETRIES {
                            break;
                        }
                    }
                }
            }

            Err(last_error.unwrap_or_else(|| app_error("AI 请求失败")))
        }
        .await;

        self.unregister_request(&request_id);
        result
    }

    fn register_request(
        &self,
        request_id: String,
        cancel_tx: oneshot::Sender<()>,
    ) -> AppResult<()> {
        let mut active_requests = self
            .active_requests
            .lock()
            .map_err(|_| app_error("AI 请求状态锁已损坏"))?;
        active_requests.insert(request_id, cancel_tx);
        Ok(())
    }

    fn unregister_request(&self, request_id: &str) {
        if let Ok(mut active_requests) = self.active_requests.lock() {
            active_requests.remove(request_id);
        }
    }

    async fn send_openai_compatible_request(
        &self,
        provider: &AiProviderConfig,
        messages: &[Message],
        request_id: &str,
    ) -> AppResult<AiChatResponse> {
        let base_url = default_base_url(&provider.provider_type, provider.base_url.as_deref())?;
        let model = default_model(&provider.provider_type, provider.model.as_deref())?;
        let api_key = provider.api_key.as_deref().map(str::trim).unwrap_or("");

        let mut request = self
            .client
            .post(format!("{base_url}/chat/completions"))
            .timeout(DEFAULT_TIMEOUT)
            .json(&OpenAiChatRequest {
                model: model.clone(),
                messages: messages
                    .iter()
                    .map(|message| OpenAiChatMessage {
                        role: normalize_role(&message.role),
                        content: message.content.clone(),
                    })
                    .collect(),
                temperature: 0.7,
            });

        if !api_key.is_empty() {
            request = request.bearer_auth(api_key);
        }

        let response = request.send().await?;
        let status = response.status();
        let response_request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);

        if !status.is_success() {
            return Err(http_error(status));
        }

        let data = response.json::<OpenAiChatResponse>().await?;
        let Some(choice) = data.choices.into_iter().next() else {
            return Err(app_error("AI 响应格式无效"));
        };

        Ok(AiChatResponse {
            content: choice.message.content,
            model: data.model.or(Some(model)),
            finish_reason: choice.finish_reason,
            request_id: response_request_id.or_else(|| Some(request_id.to_string())),
            usage: data.usage.map(|usage| AiUsage {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                total_tokens: usage.total_tokens,
            }),
        })
    }
}

impl Default for AiService {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderSecretStatus {
    pub provider_id: String,
    pub has_api_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_api_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct OpenAiChatRequest {
    model: String,
    messages: Vec<OpenAiChatMessage>,
    temperature: f32,
}

#[derive(Debug, Serialize)]
struct OpenAiChatMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    model: Option<String>,
    choices: Vec<OpenAiChoice>,
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoice {
    message: OpenAiChoiceMessage,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChoiceMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
}

fn provider_to_summary(provider: AiProviderConfig) -> AiProviderSummary {
    let has_api_key = provider
        .api_key
        .as_ref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);

    AiProviderSummary {
        id: provider.id,
        name: provider.name,
        provider_type: provider.provider_type,
        base_url: provider.base_url,
        model: provider.model,
        is_active: provider.is_active,
        has_api_key,
        masked_api_key: has_api_key.then(|| {
            let api_key = provider.api_key.unwrap_or_default();
            mask_api_key(api_key.trim()).unwrap_or_else(|| "****".to_string())
        }),
    }
}

fn validate_provider(provider: &AiProviderConfig) -> AppResult<()> {
    if !matches!(
        provider.provider_type.as_str(),
        "openai" | "openai-compatible" | "anthropic" | "gemini" | "ollama"
    ) {
        return Err(app_error(format!(
            "不支持的 Provider 类型: {}",
            provider.provider_type
        )));
    }

    let api_key = provider.api_key.as_deref().map(str::trim).unwrap_or("");
    if api_key.is_empty() && provider.provider_type != "ollama" {
        return Err(app_error("缺少 API Key"));
    }

    Ok(())
}

fn default_base_url(provider_type: &str, base_url: Option<&str>) -> AppResult<String> {
    let base_url = match base_url.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => value.to_string(),
        None => match provider_type {
            "openai" | "openai-compatible" => "https://api.openai.com/v1".to_string(),
            "anthropic" => "https://api.anthropic.com/v1".to_string(),
            "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
            "ollama" => "http://127.0.0.1:11434/v1".to_string(),
            _ => return Err(app_error("不支持的 Provider 类型")),
        },
    };

    Ok(base_url.trim_end_matches('/').to_string())
}

fn default_model(provider_type: &str, model: Option<&str>) -> AppResult<String> {
    if let Some(model) = model.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(model.to_string());
    }

    match provider_type {
        "openai" | "openai-compatible" => Ok("gpt-3.5-turbo".to_string()),
        "anthropic" => Ok("claude-3-5-sonnet-latest".to_string()),
        "gemini" => Ok("gemini-2.0-flash".to_string()),
        "ollama" => Ok("llama3.1".to_string()),
        _ => Err(app_error("不支持的 Provider 类型")),
    }
}

fn normalize_role(role: &str) -> String {
    match role {
        "system" | "assistant" | "user" => role.to_string(),
        _ => "user".to_string(),
    }
}

fn http_error(status: StatusCode) -> crate::error::AppError {
    let message = match status.as_u16() {
        401 | 403 => "AI 服务认证失败",
        408 => "AI 请求超时，请稍后重试",
        429 => "AI 服务请求过于频繁",
        value if value >= 500 => "AI 服务暂时不可用",
        _ => "AI 服务响应异常",
    };

    app_error(format!("{message} ({status})"))
}

fn is_retryable_error(error: &crate::error::AppError) -> bool {
    let message = error.to_string();
    message.contains("429")
        || message.contains("5")
        || message.contains("timed out")
        || message.contains("error sending request")
}

fn mask_api_key(api_key: &str) -> Option<String> {
    if api_key.is_empty() {
        return None;
    }

    if api_key.len() <= 8 {
        return Some("*".repeat(api_key.len()));
    }

    Some(format!(
        "{}***{}",
        &api_key[..4],
        &api_key[api_key.len() - 4..]
    ))
}
