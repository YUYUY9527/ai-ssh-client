use std::sync::Arc;

mod commands;
mod error;
mod models;
mod services;

use commands::{agent, ai, connections, files, settings, ssh};
use services::agent_history_service::AgentHistoryService;
use services::agent_service::AgentService;
use services::ai_service::AiService;
use services::sftp_service::SftpService;
use services::ssh_service::SshService;
use services::storage_service::StorageService;

/// Shared Tauri application state.
pub struct AppState {
    storage: Arc<StorageService>,
    ssh: SshService,
    sftp: SftpService,
    ai: AiService,
    agent: AgentService,
    agent_history: AgentHistoryService,
}

impl AppState {
    /// Creates application state with local services.
    pub fn new() -> Result<Self, String> {
        let storage = Arc::new(StorageService::new().map_err(|err| err.to_string())?);
        let ssh = SshService::new(storage.clone());
        Ok(Self {
            storage: Arc::clone(&storage),
            sftp: SftpService::new(ssh.clone()),
            ssh,
            ai: AiService::new(),
            agent: AgentService::new(),
            agent_history: AgentHistoryService::new().map_err(|err| err.to_string())?,
        })
    }
}

/// Runs the Tauri application.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new().expect("failed to initialize app state"))
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_disconnect,
            ssh::ssh_execute,
            ssh::ssh_execute_sync,
            ssh::ssh_get_sessions,
            ssh::ssh_test_connection,
            ssh::ssh_resize,
            ssh::ssh_get_host_trust_record,
            ssh::ssh_list_host_trust_records,
            ssh::ssh_upsert_host_trust_record,
            ssh::ssh_delete_host_trust_record,
            ssh::ssh_clear_host_trust_records,
            ssh::ssh_respond_host_trust,
            ssh::sftp_list_directory,
            ssh::sftp_rename_item,
            ssh::sftp_delete_item,
            ssh::sftp_create_directory,
            ssh::sftp_set_permissions,
            ssh::sftp_read_text_file,
            ssh::sftp_write_text_file,
            ssh::sftp_delete_items,
            ssh::sftp_start_upload,
            ssh::sftp_start_download,
            ssh::sftp_resolve_conflict,
            ssh::sftp_cancel_transfer,
            ssh::sftp_retry_transfer,
            ssh::sftp_discard_transfer,
            ssh::sftp_list_transfers,
            connections::get_connections,
            connections::save_connection,
            connections::delete_connection,
            connections::reorder_connections,
            connections::export_all_data,
            connections::import_data,
            ai::ai_chat,
            ai::ai_chat_stream,
            ai::ai_cancel_chat,
            ai::ai_get_providers,
            ai::ai_save_provider,
            ai::ai_delete_provider,
            ai::ai_test_provider,
            ai::ai_set_active_provider,
            ai::ai_get_provider_secret_status,
            settings::get_settings,
            settings::save_settings,
            settings::get_command_history,
            settings::add_command_history,
            settings::clear_command_history,
            settings::get_quick_commands,
            settings::save_quick_command,
            settings::delete_quick_command,
            settings::get_quick_command_groups,
            settings::save_quick_command_group,
            settings::delete_quick_command_group,
            files::select_file,
            files::sftp_select_files,
            files::sftp_select_download_destination,
            files::read_private_key_file,
            agent::agent_start_task,
            agent::agent_stop_task,
            agent::agent_pause_task,
            agent::agent_resume_task,
            agent::agent_get_task_history,
            agent::agent_save_task_history,
            agent::agent_clear_task_history,
            agent::agent_delete_task_history,
            agent::agent_exec_await,
            agent::agent_cancel_exec,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
