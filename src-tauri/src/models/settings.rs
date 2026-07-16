use serde::{Deserialize, Serialize};

/// App settings persisted by the Rust backend.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub language: String,
    pub theme: String,
    pub font_size: u16,
    pub font_family: String,
    pub keepalive_interval: u64,
    pub keepalive_count_max: u32,
    pub auto_reconnect: bool,
    pub max_reconnect_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approve_high_risk: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approve_medium_risk: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remember_choice: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_terminal_output_prompt: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_theme: Option<String>,
    /// xterm scrollback 行数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_scrollback: Option<u32>,
    /// 光标样式：block / underline / bar
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_cursor_style: Option<String>,
    /// 光标是否闪烁
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_cursor_blink: Option<bool>,
    /// 选中即复制
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_copy_on_select: Option<bool>,
    /// 客户端识别 Shell Integration OSC
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_shell_integration: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_semantic_summary_context_length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_persisted_sessions: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_scrollback_bytes_per_session: Option<u32>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "zh-CN".to_string(),
            theme: "dark".to_string(),
            font_size: 14,
            font_family: "Consolas, 'Courier New', monospace".to_string(),
            keepalive_interval: 60,
            keepalive_count_max: 3,
            auto_reconnect: true,
            max_reconnect_attempts: 5,
            approve_high_risk: None,
            approve_medium_risk: None,
            remember_choice: None,
            show_terminal_output_prompt: Some(true),
            terminal_theme: Some("dark".to_string()),
            terminal_scrollback: Some(3000),
            terminal_cursor_style: Some("block".to_string()),
            terminal_cursor_blink: Some(true),
            terminal_copy_on_select: Some(false),
            terminal_shell_integration: Some(true),
            agent_enabled: None,
            agent_semantic_summary_context_length: Some(12_000),
            max_persisted_sessions: Some(8),
            max_scrollback_bytes_per_session: Some(150 * 1024),
        }
    }
}

/// Command history item persisted by the Rust backend.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryItem {
    pub id: String,
    pub command: String,
    pub timestamp: u64,
    pub connection_id: String,
    pub connection_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub executed_by: String,
    pub approved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

/// Quick command group persisted by the Rust backend.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandGroup {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// Quick command persisted by the Rust backend.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::AppSettings;

    /// 终端专业设置字段必须随 camelCase JSON 往返保留，避免 save_settings 静默丢字段。
    #[test]
    fn terminal_pro_settings_round_trip_via_json() {
        let json = r#"{
            "language": "zh-CN",
            "theme": "dark",
            "fontSize": 14,
            "fontFamily": "Consolas",
            "keepaliveInterval": 60,
            "keepaliveCountMax": 3,
            "autoReconnect": true,
            "maxReconnectAttempts": 5,
            "terminalScrollback": 8000,
            "terminalCursorStyle": "bar",
            "terminalCursorBlink": false,
            "terminalCopyOnSelect": true,
            "terminalShellIntegration": true
        }"#;

        let parsed: AppSettings = serde_json::from_str(json).expect("deserialize");
        assert_eq!(parsed.terminal_scrollback, Some(8000));
        assert_eq!(parsed.terminal_cursor_style.as_deref(), Some("bar"));
        assert_eq!(parsed.terminal_cursor_blink, Some(false));
        assert_eq!(parsed.terminal_copy_on_select, Some(true));
        assert_eq!(parsed.terminal_shell_integration, Some(true));

        let encoded = serde_json::to_value(&parsed).expect("serialize");
        assert_eq!(encoded["terminalScrollback"], 8000);
        assert_eq!(encoded["terminalCursorStyle"], "bar");
        assert_eq!(encoded["terminalCursorBlink"], false);
        assert_eq!(encoded["terminalCopyOnSelect"], true);
        assert_eq!(encoded["terminalShellIntegration"], true);
    }

    #[test]
    fn terminal_pro_settings_defaults_match_shared_baseline() {
        let defaults = AppSettings::default();
        assert_eq!(defaults.terminal_scrollback, Some(3000));
        assert_eq!(defaults.terminal_cursor_style.as_deref(), Some("block"));
        assert_eq!(defaults.terminal_cursor_blink, Some(true));
        assert_eq!(defaults.terminal_copy_on_select, Some(false));
        assert_eq!(defaults.terminal_shell_integration, Some(true));
    }
}
