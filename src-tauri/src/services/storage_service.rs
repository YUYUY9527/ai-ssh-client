use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{app_error, AppResult};
use crate::models::ai::AiProviderConfig;
use crate::models::settings::{AppSettings, CommandHistoryItem, QuickCommand, QuickCommandGroup};
use crate::models::ssh::{HostTrustRecord, SshConnection};

const KEYRING_SERVICE: &str = "ai-ssh-client";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSshConnection {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreData {
    settings: AppSettings,
    ssh_connections: Vec<StoredSshConnection>,
    ai_providers: Vec<AiProviderConfig>,
    command_history: Vec<CommandHistoryItem>,
    quick_commands: Vec<QuickCommand>,
    quick_command_groups: Vec<QuickCommandGroup>,
    /// Trusted SSH host fingerprints (TOFU / future interactive verify).
    #[serde(default)]
    host_trust_records: Vec<HostTrustRecord>,
    #[serde(default)]
    legacy_ssh_secrets_migrated: bool,
    #[serde(default)]
    legacy_ai_secrets_migrated: bool,
}

impl Default for StoreData {
    fn default() -> Self {
        Self {
            settings: AppSettings::default(),
            ssh_connections: Vec::new(),
            ai_providers: Vec::new(),
            command_history: Vec::new(),
            quick_commands: Vec::new(),
            quick_command_groups: Vec::new(),
            host_trust_records: Vec::new(),
            legacy_ssh_secrets_migrated: false,
            legacy_ai_secrets_migrated: false,
        }
    }
}

/// File-backed storage used during the Tauri migration.
pub struct StorageService {
    path: PathBuf,
    data: Mutex<StoreData>,
}

fn keyring_user(connection_id: &str, field: &str) -> String {
    format!("ssh:{connection_id}:{field}")
}

fn ai_keyring_user(provider_id: &str) -> String {
    format!("ai:{provider_id}:apiKey")
}

fn get_secret(connection_id: &str, field: &str) -> Option<String> {
    let user = keyring_user(connection_id, field);
    let entry = keyring::Entry::new(KEYRING_SERVICE, &user).ok()?;
    entry.get_password().ok()
}

fn set_secret(connection_id: &str, field: &str, value: Option<&str>) {
    let user = keyring_user(connection_id, field);
    let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &user) else {
        return;
    };

    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        let _ = entry.set_password(value);
    } else {
        let _ = entry.delete_credential();
    }
}

fn get_ai_secret(provider_id: &str) -> Option<String> {
    let user = ai_keyring_user(provider_id);
    let entry = keyring::Entry::new(KEYRING_SERVICE, &user).ok()?;
    entry.get_password().ok()
}

fn set_ai_secret(provider_id: &str, value: Option<&str>) {
    let user = ai_keyring_user(provider_id);
    let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &user) else {
        return;
    };

    if let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) {
        let _ = entry.set_password(value);
    } else {
        let _ = entry.delete_credential();
    }
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

fn set_connection_secrets(connection: &SshConnection) {
    set_secret(&connection.id, "password", connection.password.as_deref());
    set_secret(
        &connection.id,
        "privateKey",
        connection.private_key.as_deref(),
    );
    set_secret(
        &connection.id,
        "passphrase",
        connection.passphrase.as_deref(),
    );
}

fn delete_connection_secrets(connection_id: &str) {
    set_secret(connection_id, "password", None);
    set_secret(connection_id, "privateKey", None);
    set_secret(connection_id, "passphrase", None);
}

impl StorageService {
    /// Loads or creates the application data store.
    pub fn new() -> AppResult<Self> {
        let data_dir = dirs::data_local_dir()
            .ok_or_else(|| app_error("无法定位本地应用数据目录"))?
            .join("ai-ssh-client");
        fs::create_dir_all(&data_dir)?;
        let path = data_dir.join("store.json");

        let mut data = if path.exists() {
            let raw = fs::read_to_string(&path)?;
            serde_json::from_str(&raw).unwrap_or_default()
        } else {
            StoreData::default()
        };

        if Self::migrate_electron_store(&mut data) {
            let raw = serde_json::to_string_pretty(&data)?;
            fs::write(&path, raw)?;
        }

        Ok(Self {
            path,
            data: Mutex::new(data),
        })
    }

    fn migrate_electron_store(data: &mut StoreData) -> bool {
        let Some(config_dir) = dirs::config_dir() else {
            return false;
        };
        let legacy_path = config_dir.join("ai-ssh-client").join("config.json");
        let Ok(raw) = fs::read_to_string(legacy_path) else {
            return false;
        };
        let Ok(legacy) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return false;
        };

        let mut changed = false;

        if data.ssh_connections.is_empty() {
            let legacy_connections = legacy
                .get("sshConnections")
                .and_then(|value| {
                    serde_json::from_value::<Vec<StoredSshConnection>>(value.clone()).ok()
                })
                .or_else(|| {
                    legacy.get("connections").and_then(|value| {
                        serde_json::from_value::<Vec<StoredSshConnection>>(value.clone()).ok()
                    })
                })
                .unwrap_or_default();

            if !legacy_connections.is_empty() {
                data.ssh_connections = legacy_connections;
                changed = true;
            }
        }

        if data.ai_providers.is_empty() {
            let legacy_providers = legacy
                .get("aiProviders")
                .and_then(|value| {
                    serde_json::from_value::<Vec<AiProviderConfig>>(value.clone()).ok()
                })
                .unwrap_or_default();
            if !legacy_providers.is_empty() {
                data.ai_providers = legacy_providers
                    .into_iter()
                    .map(|mut provider| {
                        if provider
                            .api_key
                            .as_deref()
                            .is_some_and(|value| !value.trim().is_empty())
                        {
                            set_ai_secret(&provider.id, provider.api_key.as_deref());
                            data.legacy_ai_secrets_migrated = true;
                        }
                        provider.api_key = None;
                        provider
                    })
                    .collect();
                changed = true;
            }
        }

        if data.quick_commands.is_empty() {
            let legacy_commands = legacy
                .get("quickCommands")
                .and_then(|value| serde_json::from_value::<Vec<QuickCommand>>(value.clone()).ok())
                .unwrap_or_default();
            if !legacy_commands.is_empty() {
                data.quick_commands = legacy_commands;
                changed = true;
            }
        }

        if data.quick_command_groups.is_empty() {
            let legacy_groups = legacy
                .get("quickCommandGroups")
                .and_then(|value| {
                    serde_json::from_value::<Vec<QuickCommandGroup>>(value.clone()).ok()
                })
                .unwrap_or_default();
            if !legacy_groups.is_empty() {
                data.quick_command_groups = legacy_groups;
                changed = true;
            }
        }

        if data.command_history.is_empty() {
            let mut legacy_history = legacy
                .get("commandHistory")
                .and_then(|value| {
                    serde_json::from_value::<Vec<CommandHistoryItem>>(value.clone()).ok()
                })
                .unwrap_or_default();
            if !legacy_history.is_empty() {
                legacy_history.truncate(500);
                data.command_history = legacy_history;
                changed = true;
            }
        }

        if let Some(settings) = legacy
            .get("settings")
            .and_then(|value| serde_json::from_value::<AppSettings>(value.clone()).ok())
        {
            if data.settings == AppSettings::default() {
                data.settings = settings;
                changed = true;
            }
        }

        changed
    }

    fn migrate_legacy_ai_secrets_if_needed(&self) -> AppResult<()> {
        self.update(|data| {
            if data.legacy_ai_secrets_migrated {
                return;
            }

            let Some(config_dir) = dirs::config_dir() else {
                data.legacy_ai_secrets_migrated = true;
                return;
            };
            let legacy_path = config_dir.join("ai-ssh-client").join("ai-secrets.json");
            let Ok(raw) = fs::read_to_string(legacy_path) else {
                data.legacy_ai_secrets_migrated = true;
                return;
            };
            let Ok(legacy) = serde_json::from_str::<serde_json::Value>(&raw) else {
                data.legacy_ai_secrets_migrated = true;
                return;
            };

            let Some(secret_map) = legacy
                .get("aiProviderSecrets")
                .and_then(serde_json::Value::as_object)
            else {
                data.legacy_ai_secrets_migrated = true;
                return;
            };

            for (provider_id, raw_value) in secret_map {
                let Some(raw_value) = raw_value.as_str() else {
                    continue;
                };
                let Some(secret_value) = decode_legacy_secret(raw_value) else {
                    continue;
                };
                set_ai_secret(provider_id, Some(&secret_value));
            }

            data.legacy_ai_secrets_migrated = true;
        })
    }

    fn migrate_legacy_ssh_secrets_if_needed(&self) -> AppResult<()> {
        self.update(|data| {
            if data.legacy_ssh_secrets_migrated {
                return;
            }

            let Some(config_dir) = dirs::config_dir() else {
                data.legacy_ssh_secrets_migrated = true;
                return;
            };
            let legacy_path = config_dir.join("ai-ssh-client").join("ssh-secrets.json");
            let Ok(raw) = fs::read_to_string(legacy_path) else {
                data.legacy_ssh_secrets_migrated = true;
                return;
            };
            let Ok(legacy) = serde_json::from_str::<serde_json::Value>(&raw) else {
                data.legacy_ssh_secrets_migrated = true;
                return;
            };

            let Some(secret_map) = legacy
                .get("sshConnectionSecrets")
                .and_then(serde_json::Value::as_object)
            else {
                data.legacy_ssh_secrets_migrated = true;
                return;
            };

            for (connection_id, fields) in secret_map {
                let Some(fields) = fields.as_object() else {
                    continue;
                };

                for field in ["password", "privateKey", "passphrase"] {
                    let Some(raw_value) = fields.get(field).and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(secret_value) = decode_legacy_secret(raw_value) else {
                        continue;
                    };
                    set_secret(connection_id, field, Some(&secret_value));
                }
            }

            data.legacy_ssh_secrets_migrated = true;
        })
    }

    fn persist(&self, data: &StoreData) -> AppResult<()> {
        let raw = serde_json::to_string_pretty(data)?;
        fs::write(&self.path, raw)?;
        Ok(())
    }

    fn with_data<T>(&self, action: impl FnOnce(&StoreData) -> T) -> AppResult<T> {
        let data = self.data.lock().map_err(|_| app_error("存储锁已损坏"))?;
        Ok(action(&data))
    }

    fn update<T>(&self, action: impl FnOnce(&mut StoreData) -> T) -> AppResult<T> {
        let mut data = self.data.lock().map_err(|_| app_error("存储锁已损坏"))?;
        let result = action(&mut data);
        self.persist(&data)?;
        Ok(result)
    }

    /// Returns application settings.
    pub fn get_settings(&self) -> AppResult<AppSettings> {
        self.with_data(|data| data.settings.clone())
    }

    /// Saves application settings.
    pub fn save_settings(&self, settings: AppSettings) -> AppResult<()> {
        self.update(|data| {
            data.settings = settings;
        })
    }

    /// Returns SSH connections without secrets.
    pub fn get_connections(&self) -> AppResult<Vec<SshConnection>> {
        self.migrate_legacy_ssh_secrets_if_needed()?;
        self.with_data(|data| {
            data.ssh_connections
                .iter()
                .map(|connection| SshConnection {
                    id: connection.id.clone(),
                    name: connection.name.clone(),
                    host: connection.host.clone(),
                    port: connection.port,
                    username: connection.username.clone(),
                    password: get_secret(&connection.id, "password"),
                    private_key: get_secret(&connection.id, "privateKey"),
                    passphrase: get_secret(&connection.id, "passphrase"),
                })
                .collect()
        })
    }

    /// Returns one SSH connection with secrets.
    pub fn get_connection(&self, connection_id: &str) -> AppResult<Option<SshConnection>> {
        Ok(self
            .get_connections()?
            .into_iter()
            .find(|connection| connection.id == connection_id))
    }

    /// Saves an SSH connection and persists secrets in the OS credential store.
    pub fn save_connection(&self, connection: SshConnection) -> AppResult<()> {
        set_connection_secrets(&connection);
        self.update(|data| {
            let normalized = StoredSshConnection {
                id: connection.id,
                name: connection.name,
                host: connection.host,
                port: connection.port,
                username: connection.username,
            };
            if let Some(existing) = data
                .ssh_connections
                .iter_mut()
                .find(|item| item.id == normalized.id)
            {
                *existing = normalized;
            } else {
                data.ssh_connections.push(normalized);
            }
        })
    }

    /// Deletes an SSH connection.
    pub fn delete_connection(&self, connection_id: &str) -> AppResult<()> {
        delete_connection_secrets(connection_id);
        self.update(|data| {
            data.ssh_connections
                .retain(|connection| connection.id != connection_id);
        })
    }

    /// Reorders SSH connections by the given id sequence and persists the order.
    pub fn reorder_connections(&self, connection_ids: Vec<String>) -> AppResult<()> {
        self.update(|data| {
            let mut by_id: std::collections::HashMap<String, StoredSshConnection> = data
                .ssh_connections
                .drain(..)
                .map(|connection| (connection.id.clone(), connection))
                .collect();
            let mut ordered = Vec::with_capacity(by_id.len());
            for id in connection_ids {
                if let Some(connection) = by_id.remove(&id) {
                    ordered.push(connection);
                }
            }
            ordered.extend(by_id.into_values());
            data.ssh_connections = ordered;
        })
    }

    /// Returns AI provider configs.
    pub fn get_ai_providers(&self) -> AppResult<Vec<AiProviderConfig>> {
        self.migrate_legacy_ai_secrets_if_needed()?;
        self.with_data(|data| {
            data.ai_providers
                .iter()
                .cloned()
                .map(|mut provider| {
                    provider.api_key = get_ai_secret(&provider.id).or(provider.api_key);
                    provider
                })
                .collect()
        })
    }

    /// Saves an AI provider config.
    pub fn save_ai_provider(&self, provider: AiProviderConfig) -> AppResult<()> {
        if provider
            .api_key
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            set_ai_secret(&provider.id, provider.api_key.as_deref());
        }

        self.update(|data| {
            if provider.is_active {
                for item in &mut data.ai_providers {
                    item.is_active = false;
                }
            }

            let mut stored_provider = provider;
            stored_provider.api_key = None;

            if let Some(existing) = data
                .ai_providers
                .iter_mut()
                .find(|item| item.id == stored_provider.id)
            {
                *existing = stored_provider;
            } else {
                data.ai_providers.push(stored_provider);
            }
        })
    }

    /// Deletes an AI provider config.
    pub fn delete_ai_provider(&self, provider_id: &str) -> AppResult<()> {
        set_ai_secret(provider_id, None);
        self.update(|data| {
            data.ai_providers
                .retain(|provider| provider.id != provider_id);
        })
    }

    /// Returns AI provider secret status without exposing the secret.
    pub fn get_ai_provider_secret_status(
        &self,
        provider_id: &str,
    ) -> AppResult<(bool, Option<String>)> {
        let secret = get_ai_secret(provider_id).or_else(|| {
            self.with_data(|data| {
                data.ai_providers
                    .iter()
                    .find(|provider| provider.id == provider_id)
                    .and_then(|provider| provider.api_key.clone())
            })
            .ok()
            .flatten()
        });

        Ok(match secret {
            Some(secret) if !secret.trim().is_empty() => (true, mask_api_key(secret.trim())),
            _ => (false, None),
        })
    }

    /// Sets exactly one active AI provider.
    pub fn set_active_ai_provider(&self, provider_id: &str) -> AppResult<()> {
        self.update(|data| {
            for provider in &mut data.ai_providers {
                provider.is_active = provider.id == provider_id;
            }
        })
    }

    /// Returns command history.
    pub fn get_command_history(&self) -> AppResult<Vec<CommandHistoryItem>> {
        self.with_data(|data| data.command_history.clone())
    }

    /// Adds a command history item and caps the list size.
    pub fn add_command_history(&self, item: CommandHistoryItem) -> AppResult<()> {
        self.update(|data| {
            data.command_history.insert(0, item);
            data.command_history.truncate(500);
        })
    }

    /// Clears command history.
    pub fn clear_command_history(&self) -> AppResult<()> {
        self.update(|data| data.command_history.clear())
    }

    /// Returns all trusted host fingerprint records.
    pub fn list_host_trust_records(&self) -> AppResult<Vec<HostTrustRecord>> {
        self.with_data(|data| {
            let mut records = data.host_trust_records.clone();
            records.sort_by(|left, right| {
                right
                    .trusted_at
                    .cmp(&left.trusted_at)
                    .then(left.host.cmp(&right.host))
                    .then(left.port.cmp(&right.port))
            });
            records
        })
    }

    /// Looks up a trusted host fingerprint by host + port.
    pub fn get_host_trust_record(
        &self,
        host: &str,
        port: u16,
    ) -> AppResult<Option<HostTrustRecord>> {
        let normalized_host = host.trim().to_ascii_lowercase();
        self.with_data(|data| {
            data.host_trust_records
                .iter()
                .find(|record| {
                    record.host.trim().eq_ignore_ascii_case(&normalized_host) && record.port == port
                })
                .cloned()
        })
    }

    /// Inserts or updates a trusted host fingerprint record.
    pub fn upsert_host_trust_record(&self, record: HostTrustRecord) -> AppResult<()> {
        self.update(|data| {
            let normalized_host = record.host.trim().to_ascii_lowercase();
            if let Some(existing) = data.host_trust_records.iter_mut().find(|item| {
                item.host.trim().eq_ignore_ascii_case(&normalized_host) && item.port == record.port
            }) {
                *existing = HostTrustRecord {
                    host: normalized_host,
                    ..record
                };
            } else {
                data.host_trust_records.push(HostTrustRecord {
                    host: normalized_host,
                    ..record
                });
            }
        })
    }

    /// Deletes a trusted host fingerprint record.
    pub fn delete_host_trust_record(&self, host: &str, port: u16) -> AppResult<()> {
        let normalized_host = host.trim().to_ascii_lowercase();
        self.update(|data| {
            data.host_trust_records.retain(|record| {
                !(record.host.trim().eq_ignore_ascii_case(&normalized_host) && record.port == port)
            });
        })
    }

    /// Clears all trusted host fingerprint records.
    pub fn clear_host_trust_records(&self) -> AppResult<()> {
        self.update(|data| data.host_trust_records.clear())
    }

    /// Returns quick commands.
    pub fn get_quick_commands(&self) -> AppResult<Vec<QuickCommand>> {
        self.with_data(|data| data.quick_commands.clone())
    }

    /// Saves a quick command.
    pub fn save_quick_command(&self, command: QuickCommand) -> AppResult<()> {
        self.update(|data| {
            if let Some(existing) = data
                .quick_commands
                .iter_mut()
                .find(|item| item.id == command.id)
            {
                *existing = command;
            } else {
                data.quick_commands.push(command);
            }
        })
    }

    /// Deletes a quick command.
    pub fn delete_quick_command(&self, command_id: &str) -> AppResult<()> {
        self.update(|data| {
            data.quick_commands
                .retain(|command| command.id != command_id)
        })
    }

    /// Returns quick command groups.
    pub fn get_quick_command_groups(&self) -> AppResult<Vec<QuickCommandGroup>> {
        self.with_data(|data| data.quick_command_groups.clone())
    }

    /// Saves a quick command group.
    pub fn save_quick_command_group(&self, group: QuickCommandGroup) -> AppResult<()> {
        self.update(|data| {
            if let Some(existing) = data
                .quick_command_groups
                .iter_mut()
                .find(|item| item.id == group.id)
            {
                *existing = group;
            } else {
                data.quick_command_groups.push(group);
            }
        })
    }

    /// Deletes a quick command group and its commands.
    pub fn delete_quick_command_group(&self, group_id: &str) -> AppResult<()> {
        self.update(|data| {
            data.quick_command_groups
                .retain(|group| group.id != group_id);
            data.quick_commands
                .retain(|command| command.group_id.as_deref() != Some(group_id));
        })
    }

    /// Exports persisted app data; secrets optional for safer shareable backups.
    pub fn export_all_data(&self, include_secrets: bool) -> AppResult<serde_json::Value> {
        let mut connections = self.get_connections()?;
        let mut providers = self.get_ai_providers()?;
        if !include_secrets {
            for connection in &mut connections {
                connection.password = None;
                connection.private_key = None;
                connection.passphrase = None;
            }
            for provider in &mut providers {
                provider.api_key = None;
            }
        }

        Ok(serde_json::json!({
            "version": "ai-ssh-client-1",
            "exportedAt": chrono_like_millis(),
            "includeSecrets": include_secrets,
            "connections": connections,
            "aiProviders": providers,
            "settings": self.get_settings()?,
            "commandHistory": self.get_command_history()?,
            "quickCommands": self.get_quick_commands()?,
            "quickCommandGroups": self.get_quick_command_groups()?,
            "hostTrustRecords": self.list_host_trust_records()?,
        }))
    }

    /// Imports a backup payload with merge or replace semantics.
    pub fn import_all_data(
        &self,
        payload: serde_json::Value,
        merge: bool,
    ) -> AppResult<ImportSummary> {
        let data = if payload.get("data").is_some() {
            payload.get("data").cloned().unwrap_or(payload)
        } else {
            payload
        };

        let connections = parse_connections(data.get("connections").or_else(|| data.get("sshConnections")));
        let providers = parse_ai_providers(data.get("aiProviders").or_else(|| data.get("ai_providers")));
        let settings = data
            .get("settings")
            .and_then(|value| serde_json::from_value::<AppSettings>(value.clone()).ok());
        let history = parse_command_history(
            data.get("commandHistory")
                .or_else(|| data.get("command_history")),
        );
        let quick_commands = parse_quick_commands(
            data.get("quickCommands")
                .or_else(|| data.get("quick_commands")),
        );
        let quick_groups = parse_quick_groups(
            data.get("quickCommandGroups")
                .or_else(|| data.get("quick_command_groups")),
        );
        let host_trust = parse_host_trust(
            data.get("hostTrustRecords")
                .or_else(|| data.get("host_trust_records")),
        );

        let mut skipped = Vec::new();

        if !merge {
            // 覆盖模式：先清空相关集合再写入
            let existing = self.get_connections()?;
            for connection in existing {
                let _ = self.delete_connection(&connection.id);
            }
            let existing_providers = self.get_ai_providers()?;
            for provider in existing_providers {
                let _ = self.delete_ai_provider(&provider.id);
            }
            let _ = self.clear_command_history();
            self.update(|store| {
                store.quick_commands.clear();
                store.quick_command_groups.clear();
                store.host_trust_records.clear();
            })?;
        }

        let mut imported_connections = 0usize;
        for connection in connections {
            if connection.host.trim().is_empty() || connection.username.trim().is_empty() {
                skipped.push(ImportIssue {
                    scope: "connection".to_string(),
                    id: Some(connection.id.clone()),
                    reason: "missing host or username".to_string(),
                });
                continue;
            }
            self.save_connection(connection)?;
            imported_connections += 1;
        }

        let mut imported_providers = 0usize;
        for provider in providers {
            if provider.name.trim().is_empty() {
                skipped.push(ImportIssue {
                    scope: "provider".to_string(),
                    id: Some(provider.id.clone()),
                    reason: "missing provider name".to_string(),
                });
                continue;
            }
            self.save_ai_provider(provider)?;
            imported_providers += 1;
        }

        let mut imported_settings = 0usize;
        if let Some(settings) = settings {
            self.save_settings(settings)?;
            imported_settings = 1;
        }

        let mut imported_history = 0usize;
        if !history.is_empty() {
            if merge {
                for item in history.into_iter().rev() {
                    self.add_command_history(item)?;
                    imported_history += 1;
                }
            } else {
                imported_history = history.len().min(500);
                self.update(|store| {
                    store.command_history = history;
                    store.command_history.truncate(500);
                })?;
            }
        }

        let mut imported_quick = 0usize;
        for command in quick_commands {
            self.save_quick_command(command)?;
            imported_quick += 1;
        }

        let mut imported_groups = 0usize;
        for group in quick_groups {
            self.save_quick_command_group(group)?;
            imported_groups += 1;
        }

        for record in host_trust {
            let _ = self.upsert_host_trust_record(record);
        }

        Ok(ImportSummary {
            connections: imported_connections,
            ai_providers: imported_providers,
            settings: imported_settings,
            quick_commands: imported_quick,
            quick_command_groups: imported_groups,
            command_history: imported_history,
            skipped,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssue {
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub connections: usize,
    pub ai_providers: usize,
    pub settings: usize,
    pub quick_commands: usize,
    pub quick_command_groups: usize,
    pub command_history: usize,
    pub skipped: Vec<ImportIssue>,
}

fn chrono_like_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_connections(value: Option<&serde_json::Value>) -> Vec<SshConnection> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Ok(items) = serde_json::from_value::<Vec<serde_json::Value>>(value.clone()) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|item| {
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let host = item
                .get("host")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let username = item
                .get("username")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if host.trim().is_empty() || username.trim().is_empty() {
                return None;
            }
            Some(SshConnection {
                id,
                name: item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&host)
                    .to_string(),
                host,
                port: item
                    .get("port")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(22)
                    .min(u16::MAX as u64) as u16,
                username,
                password: item
                    .get("password")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .filter(|v| !v.is_empty()),
                private_key: item
                    .get("privateKey")
                    .or_else(|| item.get("private_key"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .filter(|v| !v.is_empty()),
                passphrase: item
                    .get("passphrase")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
                    .filter(|v| !v.is_empty()),
            })
        })
        .collect()
}

fn parse_ai_providers(value: Option<&serde_json::Value>) -> Vec<AiProviderConfig> {
    value
        .and_then(|v| serde_json::from_value::<Vec<AiProviderConfig>>(v.clone()).ok())
        .unwrap_or_default()
}

fn parse_command_history(value: Option<&serde_json::Value>) -> Vec<CommandHistoryItem> {
    value
        .and_then(|v| serde_json::from_value::<Vec<CommandHistoryItem>>(v.clone()).ok())
        .unwrap_or_default()
}

fn parse_quick_commands(value: Option<&serde_json::Value>) -> Vec<QuickCommand> {
    value
        .and_then(|v| serde_json::from_value::<Vec<QuickCommand>>(v.clone()).ok())
        .unwrap_or_default()
}

fn parse_quick_groups(value: Option<&serde_json::Value>) -> Vec<QuickCommandGroup> {
    value
        .and_then(|v| serde_json::from_value::<Vec<QuickCommandGroup>>(v.clone()).ok())
        .unwrap_or_default()
}

fn parse_host_trust(value: Option<&serde_json::Value>) -> Vec<HostTrustRecord> {
    value
        .and_then(|v| serde_json::from_value::<Vec<HostTrustRecord>>(v.clone()).ok())
        .unwrap_or_default()
}

fn decode_legacy_secret(raw_value: &str) -> Option<String> {
    if let Some(payload) = raw_value.strip_prefix("plain:") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .ok()?;
        return String::from_utf8(bytes).ok();
    }

    if raw_value.starts_with("enc:") {
        return None;
    }

    Some(raw_value.to_string())
}
