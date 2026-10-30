use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Semaphore;

use crate::error::{app_error, AppResult};
use crate::models::sftp::{
    SftpBatchDeleteResult, SftpCommitGuarantee, SftpConflictPolicy, SftpDeleteItemResult,
    SftpListTransfersResult, SftpLocalFileRef, SftpResolveConflictRequest,
    SftpStartDownloadRequest, SftpStartTransferResult, SftpStartUploadRequest,
    SftpTransferDirection, SftpTransferError, SftpTransferStatus, SftpTransferTaskRequest,
    SftpTransferTaskSnapshot,
};
use crate::models::ssh::{SftpFileInfo, SshConnection};
use crate::services::ssh_service::{
    open_sftp_session, sftp_child_path, sftp_protocol_path, sftp_sibling_path,
    validate_sftp_item_path, SshService,
};

const TRANSFER_BUFFER_BYTES: usize = 64 * 1024;
const CHECKPOINT_BYTES: u64 = 4 * 1024 * 1024;
const CHECKPOINT_MS: u64 = 2000;
/// 在线编辑文本文件的最大字节数（防止大文件读入内存卡死）。
const MAX_SFTP_EDIT_BYTES: u64 = 2 * 1024 * 1024;

/// 远端文本文件读取结果（供前端编辑器使用）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTextFileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub encoding: String,
    pub max_bytes: u64,
}

/// 可信续传 sidecar（size+mtime+首尾 SHA-256 指纹）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransferCheckpoint {
    task_id: String,
    source_size: u64,
    source_mtime_ms: u64,
    #[serde(default)]
    source_head: String,
    #[serde(default)]
    source_tail: String,
    total_bytes: u64,
    confirmed_offset: u64,
    destination_path: String,
}

#[derive(Clone)]
enum TransferSource {
    Upload {
        local_path: String,
        remote_directory: String,
    },
    Download {
        remote_path: String,
        destination: String,
    },
}

#[derive(Clone)]
struct TaskRecord {
    snapshot: SftpTransferTaskSnapshot,
    source: TransferSource,
    canceled: Arc<AtomicBool>,
}

struct CachedSftpSession {
    sftp: Arc<russh_sftp::client::SftpSession>,
    _transport: russh::client::Handle<crate::services::ssh_service::SshHandler>,
}

/// Owns desktop SFTP tasks independently from interactive terminal transports.
#[derive(Clone)]
pub struct SftpService {
    ssh: SshService,
    tasks: Arc<Mutex<HashMap<String, TaskRecord>>>,
    transfer_permits: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    target_locks: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    sessions: Arc<tokio::sync::Mutex<HashMap<String, Arc<CachedSftpSession>>>>,
}

impl SftpService {
    /// Creates the desktop SFTP task registry.
    pub fn new(ssh: SshService) -> Self {
        Self {
            ssh,
            tasks: Arc::new(Mutex::new(HashMap::new())),
            transfer_permits: Arc::new(Mutex::new(HashMap::new())),
            target_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    /// Creates upload tasks and starts each file independently.
    pub fn start_upload(
        &self,
        app_handle: AppHandle,
        request: SftpStartUploadRequest,
    ) -> AppResult<SftpStartTransferResult> {
        if request.files.is_empty() {
            return Err(app_error("No files selected"));
        }
        validate_directory_path(&request.remote_directory)?;

        let batch_id = uuid::Uuid::new_v4().to_string();
        let policy = request.conflict_policy.unwrap_or(SftpConflictPolicy::Ask);
        // 阶段 1：只校验并规划，不插入任务、不发射、不 spawn。
        let plan = plan_upload_batch(
            &request.connection_id,
            &request.files,
            &request.remote_directory,
            &batch_id,
            &policy,
        )?;
        // 阶段 2：全部插入后再统一发射、启动。
        self.commit_batch(app_handle, plan)
    }

    /// Creates download tasks and starts each selected remote file independently.
    pub fn start_download(
        &self,
        app_handle: AppHandle,
        request: SftpStartDownloadRequest,
    ) -> AppResult<SftpStartTransferResult> {
        if request.remote_paths.is_empty() {
            return Err(app_error("No remote files selected"));
        }
        let destination = request
            .destination
            .path
            .ok_or_else(|| app_error("Desktop download requires a local destination directory"))?;
        if !Path::new(&destination).is_dir() {
            return Err(app_error("Download destination is not a directory"));
        }

        let batch_id = uuid::Uuid::new_v4().to_string();
        let policy = request.conflict_policy.unwrap_or(SftpConflictPolicy::Ask);
        let plan = plan_download_batch(
            &request.connection_id,
            &request.remote_paths,
            &destination,
            &batch_id,
            &policy,
        )?;
        self.commit_batch(app_handle, plan)
    }

    /// 阶段 2：先插入全部计划任务；任一插入失败则回滚已插入项并在此之前不启动任何任务。
    fn commit_batch(
        &self,
        app_handle: AppHandle,
        plan: Vec<(SftpTransferTaskSnapshot, TransferSource)>,
    ) -> AppResult<SftpStartTransferResult> {
        let mut snapshots: Vec<SftpTransferTaskSnapshot> = Vec::with_capacity(plan.len());
        for (snapshot, source) in &plan {
            if let Err(error) = self.insert_task(snapshot.clone(), source.clone()) {
                for inserted in &snapshots {
                    self.remove_task(&inserted.task_id);
                }
                return Err(error);
            }
            snapshots.push(snapshot.clone());
        }
        for snapshot in &snapshots {
            self.emit_snapshot(&app_handle, snapshot);
            self.spawn_transfer(app_handle.clone(), snapshot.task_id.clone());
        }
        Ok(SftpStartTransferResult { tasks: snapshots })
    }

    /// Cancels a queued, waiting, or active task; active upload artifacts are cleaned when possible.
    pub fn cancel(
        &self,
        app_handle: &AppHandle,
        request: SftpTransferTaskRequest,
    ) -> AppResult<()> {
        let snapshot = self.cancel_task(&request.task_id)?;
        self.emit_snapshot(app_handle, &snapshot);
        Ok(())
    }

    /// 单次持锁完成取消判定，避免与 commit 的读-改-写竞态。
    fn cancel_task(&self, task_id: &str) -> AppResult<SftpTransferTaskSnapshot> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| app_error("SFTP task registry lock is poisoned"))?;
        let record = tasks
            .get_mut(task_id)
            .ok_or_else(|| app_error("SFTP task not found"))?;
        if record.snapshot.status == SftpTransferStatus::Committing {
            return Err(app_error("Transfer commit is in progress"));
        }
        if is_terminal(&record.snapshot.status) {
            return Ok(record.snapshot.clone());
        }
        record.canceled.store(true, Ordering::Release);
        record.snapshot.status = cancel_status(&record.snapshot.status);
        if record.snapshot.status == SftpTransferStatus::Canceled {
            record.snapshot.completed_at = Some(now_millis());
        }
        record.snapshot.sequence += 1;
        record.snapshot.updated_at = now_millis();
        Ok(record.snapshot.clone())
    }

    /// Requeues a terminal task using the same stable task ID and a new attempt number.
    pub fn retry(
        &self,
        app_handle: AppHandle,
        request: SftpTransferTaskRequest,
    ) -> AppResult<SftpTransferTaskSnapshot> {
        let current = self.task(&request.task_id)?;
        if !matches!(
            current.snapshot.status,
            SftpTransferStatus::Failed
                | SftpTransferStatus::Interrupted
                | SftpTransferStatus::Canceled
                | SftpTransferStatus::Skipped
        ) {
            return Err(app_error("Transfer is not retryable"));
        }
        // 重试前读取本地/已记录 offset；实际续传在 run_* 中再校验指纹。
        let resume_hint = current.snapshot.transferred_bytes;
        let snapshot = self.update_task(&request.task_id, |record| {
            record.canceled.store(false, Ordering::Release);
            record.snapshot.attempt += 1;
            record.snapshot.status = SftpTransferStatus::Queued;
            record.snapshot.transferred_bytes = resume_hint;
            record.snapshot.resumed_from = resume_hint;
            record.snapshot.progress = if let Some(total) = record.snapshot.total_bytes {
                if total > 0 {
                    ((resume_hint.min(total) * 100) / total) as u32
                } else {
                    0
                }
            } else {
                0
            };
            record.snapshot.error = None;
            record.snapshot.conflict = None;
            record.snapshot.completed_at = None;
        })?;
        self.emit_snapshot(&app_handle, &snapshot);
        self.spawn_transfer(app_handle, snapshot.task_id.clone());
        Ok(snapshot)
    }

    /// Resolves an ask-mode conflict and resumes the current task attempt.
    pub fn resolve_conflict(
        &self,
        app_handle: AppHandle,
        request: SftpResolveConflictRequest,
    ) -> AppResult<()> {
        let current = self.task(&request.task_id)?;
        if current.snapshot.attempt != request.attempt
            || current.snapshot.status != SftpTransferStatus::WaitingConflict
        {
            return Err(app_error(
                "Transfer is not waiting for this conflict decision",
            ));
        }
        if matches!(request.policy, SftpConflictPolicy::Ask) {
            return Err(app_error("Conflict resolution requires a concrete policy"));
        }
        let renamed_path = if matches!(request.policy, SftpConflictPolicy::Rename) {
            Some(
                request
                    .renamed_path
                    .clone()
                    .or_else(|| {
                        current
                            .snapshot
                            .conflict
                            .as_ref()
                            .and_then(|conflict| conflict.suggested_name.clone())
                    })
                    .ok_or_else(|| app_error("Conflict rename target is missing"))?,
            )
        } else {
            None
        };
        let direction = current.snapshot.direction.clone();
        let batch_id = current.snapshot.batch_id.clone();
        let connection_id = current.snapshot.connection_id.clone();
        let snapshot = self.update_task(&request.task_id, |record| {
            record.snapshot.conflict_policy = request.policy.clone();
            if let Some(path) = renamed_path {
                match direction {
                    SftpTransferDirection::Upload => record.snapshot.remote_path = Some(path),
                    SftpTransferDirection::Download => record.snapshot.local_path = Some(path),
                }
            }
            record.snapshot.status = SftpTransferStatus::Queued;
            record.snapshot.conflict = None;
        })?;
        self.emit_snapshot(&app_handle, &snapshot);
        self.spawn_transfer(app_handle.clone(), snapshot.task_id.clone());

        // 可选：把同一批次尚未开始提交的任务统一到同一冲突策略。
        if request.apply_to_batch {
            if let Some(batch_id) = batch_id {
                self.apply_policy_to_batch(
                    &app_handle,
                    &connection_id,
                    &batch_id,
                    &direction,
                    &request.task_id,
                    request.policy.clone(),
                )?;
            }
        }
        Ok(())
    }

    /// Applies a concrete conflict policy to remaining batch peers that are still waiting or queued.
    fn apply_policy_to_batch(
        &self,
        app_handle: &AppHandle,
        connection_id: &str,
        batch_id: &str,
        direction: &SftpTransferDirection,
        exclude_task_id: &str,
        policy: SftpConflictPolicy,
    ) -> AppResult<()> {
        let peer_ids = {
            let tasks = self
                .tasks
                .lock()
                .map_err(|_| app_error("SFTP task registry lock is poisoned"))?;
            tasks
                .values()
                .filter(|record| {
                    record.snapshot.task_id != exclude_task_id
                        && record.snapshot.connection_id == connection_id
                        && record.snapshot.batch_id.as_deref() == Some(batch_id)
                        && matches!(
                            (&record.snapshot.direction, direction),
                            (SftpTransferDirection::Upload, SftpTransferDirection::Upload)
                                | (
                                    SftpTransferDirection::Download,
                                    SftpTransferDirection::Download
                                )
                        )
                        && matches!(
                            record.snapshot.status,
                            SftpTransferStatus::WaitingConflict
                                | SftpTransferStatus::Queued
                                | SftpTransferStatus::Checking
                        )
                })
                .map(|record| record.snapshot.task_id.clone())
                .collect::<Vec<_>>()
        };

        for task_id in peer_ids {
            let was_waiting = self
                .task(&task_id)
                .map(|record| record.snapshot.status == SftpTransferStatus::WaitingConflict)
                .unwrap_or(false);
            let snapshot = self.update_task(&task_id, |record| {
                record.snapshot.conflict_policy = policy.clone();
                if matches!(policy, SftpConflictPolicy::Rename) {
                    if let Some(suggested) = record
                        .snapshot
                        .conflict
                        .as_ref()
                        .and_then(|conflict| conflict.suggested_name.clone())
                    {
                        match record.snapshot.direction {
                            SftpTransferDirection::Upload => {
                                record.snapshot.remote_path = Some(suggested)
                            }
                            SftpTransferDirection::Download => {
                                record.snapshot.local_path = Some(suggested)
                            }
                        }
                    }
                }
                record.snapshot.status = SftpTransferStatus::Queued;
                record.snapshot.conflict = None;
            })?;
            self.emit_snapshot(app_handle, &snapshot);
            if was_waiting {
                self.spawn_transfer(app_handle.clone(), task_id);
            }
        }
        Ok(())
    }

    /// Removes only a terminal task record and cleans local partial/meta when present.
    pub fn discard(&self, request: SftpTransferTaskRequest) -> AppResult<()> {
        let record = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| app_error("SFTP task registry lock is poisoned"))?;
            let Some(record) = tasks.get(&request.task_id) else {
                return Ok(());
            };
            if !is_terminal(&record.snapshot.status) {
                return Err(app_error("Transfer is still active"));
            }
            let cloned = record.clone();
            tasks.remove(&request.task_id);
            cloned
        };
        // 尽力清理本地下载 partial；远端 partial 由用户侧重试/覆盖处理。
        if let TransferSource::Download { destination, .. } = &record.source {
            let name = record.snapshot.name.clone();
            let local_path = record
                .snapshot
                .local_path
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| Path::new(destination).join(&name));
            let temp = temp_local_path(&local_path, &record.snapshot.task_id);
            let _ = std::fs::remove_file(&temp);
            let _ = std::fs::remove_file(local_meta_path(&temp));
        }
        Ok(())
    }

    /// Returns task snapshots, optionally scoped to a connection.
    pub fn list(&self, connection_id: Option<&str>) -> AppResult<SftpListTransfersResult> {
        let tasks = self
            .tasks
            .lock()
            .map_err(|_| app_error("SFTP task registry lock is poisoned"))?;
        let mut snapshots = tasks
            .values()
            .map(|record| record.snapshot.clone())
            .filter(|task| connection_id.is_none_or(|id| task.connection_id == id))
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|task| task.created_at);
        Ok(SftpListTransfersResult { tasks: snapshots })
    }

    /// Lists a remote directory using a reusable SFTP channel.
    pub async fn list_directory(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
    ) -> AppResult<Vec<SftpFileInfo>> {
        let protocol_path = sftp_protocol_path(&remote_path);
        self.with_sftp(&app_handle, &connection, |sftp| {
            let remote_path = remote_path.clone();
            let protocol_path = protocol_path.clone();
            async move {
                let entries = sftp.read_dir(protocol_path.as_str()).await?;
                let mut files = Vec::new();
                for entry in entries {
                    let filename = entry.file_name();
                    let path = if remote_path == "/" {
                        format!("/{filename}")
                    } else {
                        format!("{}/{}", remote_path.trim_end_matches('/'), filename)
                    };
                    let metadata = entry.metadata();
                    files.push(SftpFileInfo {
                        name: filename,
                        path,
                        kind: if metadata.is_symlink() {
                            "symlink".to_string()
                        } else if metadata.is_dir() {
                            "directory".to_string()
                        } else {
                            "file".to_string()
                        },
                        size: metadata.len(),
                        is_directory: metadata.is_dir(),
                        is_symbolic_link: metadata.is_symlink(),
                        mode: metadata
                            .permissions
                            .map(|mode| format!("{mode:o}"))
                            .unwrap_or_default(),
                        mtime: metadata.mtime.map(|value| value as i64 * 1000).unwrap_or(0),
                        atime: metadata.atime.map(|value| value as i64 * 1000).unwrap_or(0),
                        file_type: if metadata.is_dir() {
                            "directory".to_string()
                        } else {
                            "file".to_string()
                        },
                    });
                }
                files.sort_by(|left, right| {
                    right
                        .is_directory
                        .cmp(&left.is_directory)
                        .then_with(|| left.name.cmp(&right.name))
                });
                Ok(files)
            }
        })
        .await
    }

    /// Renames a remote item without replacing an existing sibling.
    pub async fn rename_item(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
        new_name: String,
    ) -> AppResult<()> {
        let destination = sftp_sibling_path(&remote_path, &new_name)?;
        let source = sftp_protocol_path(&remote_path);
        let destination = sftp_protocol_path(&destination);
        self.with_sftp(&app_handle, &connection, |sftp| {
            let source = source.clone();
            let destination = destination.clone();
            async move {
                match sftp.symlink_metadata(destination.as_str()).await {
                    Ok(_) => return Err(app_error("Destination already exists")),
                    Err(SftpError::Status(status))
                        if status.status_code == StatusCode::NoSuchFile => {}
                    Err(error) => return Err(error.into()),
                }
                sftp.rename(source, destination).await?;
                Ok(())
            }
        })
        .await
    }

    /// Deletes a remote file, symlink, or directory tree without following symlinks.
    pub async fn delete_item(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
    ) -> AppResult<()> {
        validate_sftp_item_path(&remote_path)?;
        self.with_sftp(&app_handle, &connection, |sftp| {
            let remote_path = remote_path.clone();
            async move {
                let mut stack = vec![(sftp_protocol_path(&remote_path), false)];
                while let Some((path, visited)) = stack.pop() {
                    if visited {
                        sftp.remove_dir(path).await?;
                        continue;
                    }

                    let metadata = sftp.symlink_metadata(path.as_str()).await?;
                    if !metadata.is_dir() || metadata.is_symlink() {
                        sftp.remove_file(path).await?;
                        continue;
                    }

                    let entries = sftp.read_dir(path.as_str()).await?;
                    stack.push((path.clone(), true));
                    let mut children = entries
                        .into_iter()
                        .map(|entry| entry.file_name())
                        .filter(|name| name != "." && name != "..")
                        .collect::<Vec<_>>();
                    children.reverse();
                    for name in children {
                        stack.push((sftp_child_path(&path, &name), false));
                    }
                }
                Ok(())
            }
        })
        .await
    }

    /// Creates one remote directory after validating that it is a direct child path.
    pub async fn create_directory(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
    ) -> AppResult<()> {
        validate_remote_path(&remote_path)?;
        let protocol_path = sftp_protocol_path(&remote_path);
        self.with_sftp(&app_handle, &connection, |sftp| {
            let protocol_path = protocol_path.clone();
            async move {
                sftp.create_dir(protocol_path.as_str()).await?;
                Ok(())
            }
        })
        .await
    }

    /// 修改远端文件/目录权限（chmod，仅 permission bits）。
    pub async fn set_permissions(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
        mode: u32,
    ) -> AppResult<()> {
        validate_sftp_item_path(&remote_path)?;
        // 仅允许 rwx 与 setuid/setgid/sticky（0o7777）
        let mode = mode & 0o7777;
        let protocol_path = sftp_protocol_path(&remote_path);
        self.with_sftp(&app_handle, &connection, |sftp| {
            let protocol_path = protocol_path.clone();
            async move {
                let mut attrs = FileAttributes::empty();
                attrs.permissions = Some(mode);
                sftp.set_metadata(protocol_path.as_str(), attrs).await?;
                Ok(())
            }
        })
        .await
    }

    /// 读取远端文本文件（有大小上限，避免大文件拖垮 UI）。
    pub async fn read_text_file(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
    ) -> AppResult<SftpTextFileContent> {
        validate_sftp_item_path(&remote_path)?;
        let protocol_path = sftp_protocol_path(&remote_path);
        let display_path = remote_path.clone();
        self.with_sftp(&app_handle, &connection, |sftp| {
            let protocol_path = protocol_path.clone();
            let display_path = display_path.clone();
            async move {
                let mut file = sftp.open(protocol_path.as_str()).await?;
                let metadata = file.metadata().await?;
                if metadata.is_dir() {
                    return Err(app_error("Cannot edit a directory"));
                }
                let size = metadata.len();
                if size > MAX_SFTP_EDIT_BYTES {
                    return Err(app_error(format!(
                        "File too large to edit ({} bytes, max {} bytes)",
                        size, MAX_SFTP_EDIT_BYTES
                    )));
                }
                let mut bytes = Vec::new();
                let mut buffer = vec![0_u8; 8 * 1024];
                loop {
                    let read = file.read(&mut buffer).await?;
                    if read == 0 {
                        break;
                    }
                    if bytes.len() as u64 + read as u64 > MAX_SFTP_EDIT_BYTES {
                        return Err(app_error(format!(
                            "File too large to edit (max {} bytes)",
                            MAX_SFTP_EDIT_BYTES
                        )));
                    }
                    bytes.extend_from_slice(&buffer[..read]);
                }
                let size = bytes.len() as u64;
                let content = String::from_utf8(bytes).map_err(|_| {
                    app_error("File is not valid UTF-8 text and cannot be edited in-app")
                })?;
                Ok(SftpTextFileContent {
                    path: display_path,
                    content,
                    size,
                    encoding: "utf-8".to_string(),
                    max_bytes: MAX_SFTP_EDIT_BYTES,
                })
            }
        })
        .await
    }

    /// 覆盖写入远端文本文件（同样受大小上限约束）。
    pub async fn write_text_file(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_path: String,
        content: String,
    ) -> AppResult<()> {
        validate_sftp_item_path(&remote_path)?;
        let bytes = content.into_bytes();
        if bytes.len() as u64 > MAX_SFTP_EDIT_BYTES {
            return Err(app_error(format!(
                "Content too large to save (max {} bytes)",
                MAX_SFTP_EDIT_BYTES
            )));
        }
        let protocol_path = sftp_protocol_path(&remote_path);
        self.with_sftp(&app_handle, &connection, |sftp| {
            let protocol_path = protocol_path.clone();
            let bytes = bytes.clone();
            async move {
                let mut file = sftp
                    .open_with_flags(
                        protocol_path.as_str(),
                        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                    )
                    .await?;
                file.write_all(&bytes).await?;
                file.flush().await.ok();
                Ok(())
            }
        })
        .await
    }

    /// Deletes all requested paths and reports individual outcomes without aborting the batch.
    pub async fn delete_items(
        &self,
        app_handle: AppHandle,
        connection: SshConnection,
        remote_paths: Vec<String>,
    ) -> SftpBatchDeleteResult {
        let paths = collapse_descendants(remote_paths);
        let mut items = Vec::with_capacity(paths.len());
        for path in paths {
            // 复用缓存会话，避免批量删除时反复建连
            let outcome = self
                .delete_item(app_handle.clone(), connection.clone(), path.clone())
                .await;
            items.push(match outcome {
                Ok(()) => SftpDeleteItemResult {
                    path,
                    success: true,
                    error: None,
                    code: None,
                },
                Err(error) => SftpDeleteItemResult {
                    path,
                    success: false,
                    error: Some(error.to_string()),
                    code: Some("io-error".to_string()),
                },
            });
        }
        let deleted_count = items.iter().filter(|item| item.success).count();
        let failed_count = items.len() - deleted_count;
        SftpBatchDeleteResult {
            items,
            deleted_count,
            failed_count,
        }
    }

    fn insert_task(
        &self,
        snapshot: SftpTransferTaskSnapshot,
        source: TransferSource,
    ) -> AppResult<()> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| app_error("SFTP task registry lock is poisoned"))?;
        tasks.insert(
            snapshot.task_id.clone(),
            TaskRecord {
                snapshot,
                source,
                canceled: Arc::new(AtomicBool::new(false)),
            },
        );
        Ok(())
    }

    /// Best-effort removal used to roll back a partially inserted batch.
    fn remove_task(&self, task_id: &str) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(task_id);
        }
    }

    fn spawn_transfer(&self, app_handle: AppHandle, task_id: String) {
        let service = self.clone();
        let attempt = match service.task(&task_id) {
            Ok(record) => record.snapshot.attempt,
            Err(_) => return,
        };
        tauri::async_runtime::spawn(async move {
            if let Err(error) = service.run_transfer(&app_handle, &task_id, attempt).await {
                service.fail_task(&app_handle, &task_id, attempt, error.to_string());
            }
        });
    }

    async fn run_transfer(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        attempt: u32,
    ) -> AppResult<()> {
        let current = self.task(task_id)?;
        if current.snapshot.attempt != attempt || is_terminal(&current.snapshot.status) {
            return Ok(());
        }
        let connection_id = current.snapshot.connection_id.clone();
        let permits = self.transfer_permits_for(&connection_id)?;
        let permit = permits
            .acquire_owned()
            .await
            .map_err(|_| app_error("SFTP transfer scheduler is closed"))?;
        let record = self.task(task_id)?;
        if record.snapshot.attempt != attempt || is_terminal(&record.snapshot.status) {
            return Ok(());
        }
        let record = self.transition(app_handle, task_id, SftpTransferStatus::Checking)?;
        if record.canceled.load(Ordering::Acquire) {
            drop(permit);
            self.complete_canceled(app_handle, task_id)?;
            return Ok(());
        }
        match record.source {
            TransferSource::Upload {
                local_path,
                remote_directory,
            } => {
                self.run_upload(app_handle, task_id, &local_path, &remote_directory)
                    .await
            }
            TransferSource::Download {
                remote_path,
                destination,
            } => {
                self.run_download(app_handle, task_id, &remote_path, &destination)
                    .await
            }
        }
    }

    async fn run_upload(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        local_path: &str,
        _remote_directory: &str,
    ) -> AppResult<()> {
        let record = self.task(task_id)?;
        let connection = self.connection_for(&record.snapshot.connection_id)?;
        let total = tokio::fs::metadata(local_path).await?.len();
        let mut remote_path = record
            .snapshot
            .remote_path
            .clone()
            .ok_or_else(|| app_error("Upload target is missing"))?;
        let target_lock = self
            .target_lock_for(&record.snapshot.connection_id, "remote", &remote_path)
            .await;
        let _target_guard = target_lock.lock().await;
        let sftp_session = self.session_for(app_handle, &connection).await?;
        let sftp = &sftp_session.sftp;

        if sftp.symlink_metadata(&remote_path).await.is_ok() {
            match record.snapshot.conflict_policy {
                SftpConflictPolicy::Ask => {
                    self.wait_for_conflict(
                        app_handle,
                        task_id,
                        local_path.to_string(),
                        remote_path,
                        total,
                    )?;
                    return Ok(());
                }
                SftpConflictPolicy::Skip => {
                    self.finish(
                        app_handle,
                        task_id,
                        SftpTransferStatus::Skipped,
                        None,
                        SftpCommitGuarantee::None,
                    )?;
                    return Ok(());
                }
                SftpConflictPolicy::Rename => {
                    remote_path = next_remote_name(&remote_path, task_id);
                    self.update_task(task_id, |task| {
                        task.snapshot.remote_path = Some(remote_path.clone())
                    })?;
                }
                SftpConflictPolicy::Overwrite => {}
            }
        }

        let temp_path = temp_remote_path(&remote_path, task_id);
        let meta_path = format!("{temp_path}.meta");
        let source_meta = tokio::fs::metadata(local_path).await?;
        let source_mtime_ms = file_mtime_ms(&source_meta);
        let (source_head, source_tail) = hash_local_file_edges(local_path).await?;
        let mut offset = self
            .resolve_remote_resume_offset(
                sftp,
                &temp_path,
                &meta_path,
                task_id,
                total,
                source_mtime_ms,
                &source_head,
                &source_tail,
            )
            .await?;

        let mut local_file = tokio::fs::File::open(local_path).await?;
        if offset > 0 {
            local_file.seek(SeekFrom::Start(offset)).await?;
        }
        let flags = if offset > 0 {
            OpenFlags::CREATE | OpenFlags::WRITE
        } else {
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
        };
        let mut remote_file = sftp.open_with_flags(&temp_path, flags).await?;
        if offset > 0 {
            // 续传：定位到已确认 offset；不支持 seek 时退回全量重传。
            if remote_file.seek(SeekFrom::Start(offset)).await.is_err() {
                offset = 0;
                local_file.seek(SeekFrom::Start(0)).await?;
                drop(remote_file);
                remote_file = sftp
                    .open_with_flags(
                        &temp_path,
                        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                    )
                    .await?;
            }
        }

        self.update_task(task_id, |task| {
            task.snapshot.resumed_from = offset;
            task.snapshot.transferred_bytes = offset;
            task.snapshot.total_bytes = Some(total);
        })?;
        self.transition(app_handle, task_id, SftpTransferStatus::Transferring)?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = offset;
        let mut last_checkpoint_bytes = offset;
        let mut last_checkpoint_at = now_millis();
        loop {
            if self.task(task_id)?.canceled.load(Ordering::Acquire) {
                let _ = remote_file.shutdown().await;
                // 用户明确取消正在写入的上传时清理远端临时文件；
                // 失败/中断仍保留 checkpoint 以支持续传。
                let _ = sftp.remove_file(&temp_path).await;
                let _ = sftp.remove_file(&meta_path).await;
                self.complete_canceled(app_handle, task_id)?;
                return Ok(());
            }
            let read = local_file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            remote_file.write_all(&buffer[..read]).await?;
            transferred += read as u64;
            self.progress(app_handle, task_id, transferred, total)?;
            if transferred - last_checkpoint_bytes >= CHECKPOINT_BYTES
                || now_millis().saturating_sub(last_checkpoint_at) >= CHECKPOINT_MS
            {
                let _ = write_remote_checkpoint(
                    sftp,
                    &meta_path,
                    &TransferCheckpoint {
                        task_id: task_id.to_string(),
                        source_size: total,
                        source_mtime_ms,
                        source_head: source_head.clone(),
                        source_tail: source_tail.clone(),
                        total_bytes: total,
                        confirmed_offset: transferred,
                        destination_path: remote_path.clone(),
                    },
                )
                .await;
                last_checkpoint_bytes = transferred;
                last_checkpoint_at = now_millis();
            }
        }
        remote_file.flush().await?;
        remote_file.shutdown().await?;
        // 提交前的最后一刻在锁内做一次性决定：若取消在 shutdown 期间落地则放弃 rename。
        if !self.begin_commit(app_handle, task_id)? {
            let _ = sftp.remove_file(&temp_path).await;
            let _ = sftp.remove_file(&meta_path).await;
            self.complete_canceled(app_handle, task_id)?;
            return Ok(());
        }
        sftp.rename(&temp_path, &remote_path).await?;
        let _ = sftp.remove_file(&meta_path).await;
        let guarantee = if matches!(
            record.snapshot.conflict_policy,
            SftpConflictPolicy::Overwrite
        ) {
            SftpCommitGuarantee::BestEffortReplace
        } else {
            SftpCommitGuarantee::AtomicCreate
        };
        self.finish(
            app_handle,
            task_id,
            SftpTransferStatus::Completed,
            None,
            guarantee,
        )
    }

    /// 解析远端 partial 续传 offset；源指纹变化时返回 source-changed。
    async fn resolve_remote_resume_offset(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        temp_path: &str,
        meta_path: &str,
        task_id: &str,
        source_size: u64,
        source_mtime_ms: u64,
        source_head: &str,
        source_tail: &str,
    ) -> AppResult<u64> {
        let checkpoint = read_remote_checkpoint(sftp, meta_path).await;
        let part_size = match sftp.symlink_metadata(temp_path).await {
            Ok(meta) => meta.len(),
            Err(_) => 0,
        };
        let Some(checkpoint) = checkpoint else {
            if part_size > 0 {
                let _ = sftp.remove_file(temp_path).await;
            }
            return Ok(0);
        };
        if checkpoint.task_id != task_id
            || checkpoint.source_size != source_size
            || checkpoint.source_mtime_ms != source_mtime_ms
            || (!checkpoint.source_head.is_empty()
                && !source_head.is_empty()
                && checkpoint.source_head != source_head)
            || (!checkpoint.source_tail.is_empty()
                && !source_tail.is_empty()
                && checkpoint.source_tail != source_tail)
        {
            let _ = sftp.remove_file(temp_path).await;
            let _ = sftp.remove_file(meta_path).await;
            return Err(app_error("SOURCE_CHANGED: source file changed; restart required"));
        }
        let trusted = checkpoint.confirmed_offset.min(part_size).min(source_size);
        if part_size > trusted {
            let _ = sftp.remove_file(temp_path).await;
            let _ = sftp.remove_file(meta_path).await;
            return Ok(0);
        }
        Ok(trusted)
    }

    async fn run_download(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        remote_path: &str,
        destination: &str,
    ) -> AppResult<()> {
        let record = self.task(task_id)?;
        let connection = self.connection_for(&record.snapshot.connection_id)?;
        let name = Path::new(remote_path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| app_error("Remote file name is invalid"))?;
        let mut local_path = record
            .snapshot
            .local_path
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(destination).join(name));
        let target_lock = self
            .target_lock_for(
                &record.snapshot.connection_id,
                "local",
                &local_path.to_string_lossy(),
            )
            .await;
        let _target_guard = target_lock.lock().await;
        if local_path.exists() {
            match record.snapshot.conflict_policy {
                SftpConflictPolicy::Ask => {
                    self.wait_for_conflict(
                        app_handle,
                        task_id,
                        remote_path.to_string(),
                        local_path.to_string_lossy().to_string(),
                        0,
                    )?;
                    return Ok(());
                }
                SftpConflictPolicy::Skip => {
                    return self.finish(
                        app_handle,
                        task_id,
                        SftpTransferStatus::Skipped,
                        None,
                        SftpCommitGuarantee::None,
                    )
                }
                SftpConflictPolicy::Rename => local_path = next_local_name(&local_path, task_id),
                SftpConflictPolicy::Overwrite => {}
            }
        }
        let sftp_session = self.session_for(app_handle, &connection).await?;
        let mut remote_file = sftp_session.sftp.open(remote_path).await?;
        let total = remote_file.metadata().await?.len();
        let remote_mtime_ms = remote_file
            .metadata()
            .await
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        // 记录源文件首尾指纹；计算失败视为不可校验（空串），续传时绝不盲目拼接。
        let (source_head, source_tail) =
            match hash_remote_file_edges(&sftp_session.sftp, remote_path, total).await {
                Ok(edges) => edges,
                Err(_) => (String::new(), String::new()),
            };
        let temp_path = temp_local_path(&local_path, task_id);
        let meta_path = local_meta_path(&temp_path);
        let mut offset = resolve_local_resume_offset(
            &temp_path,
            &meta_path,
            task_id,
            total,
            remote_mtime_ms,
            &source_head,
            &source_tail,
        )?;

        let mut local_file = if offset > 0 {
            tokio::fs::OpenOptions::new()
                .write(true)
                .read(true)
                .open(&temp_path)
                .await?
        } else {
            tokio::fs::File::create(&temp_path).await?
        };
        if offset > 0 {
            local_file.seek(SeekFrom::Start(offset)).await?;
            if remote_file.seek(SeekFrom::Start(offset)).await.is_err() {
                offset = 0;
                local_file = tokio::fs::File::create(&temp_path).await?;
                remote_file = sftp_session.sftp.open(remote_path).await?;
            }
        }

        self.update_task(task_id, |task| {
            task.snapshot.resumed_from = offset;
            task.snapshot.transferred_bytes = offset;
            task.snapshot.total_bytes = Some(total);
            task.snapshot.local_path = Some(local_path.to_string_lossy().to_string());
        })?;
        self.transition(app_handle, task_id, SftpTransferStatus::Transferring)?;
        let mut buffer = vec![0_u8; TRANSFER_BUFFER_BYTES];
        let mut transferred = offset;
        let mut last_checkpoint_bytes = offset;
        let mut last_checkpoint_at = now_millis();
        loop {
            if self.task(task_id)?.canceled.load(Ordering::Acquire) {
                local_file.flush().await?;
                let _ = write_local_checkpoint(
                    &meta_path,
                    &TransferCheckpoint {
                        task_id: task_id.to_string(),
                        source_size: total,
                        source_mtime_ms: remote_mtime_ms,
                        source_head: source_head.clone(),
                        source_tail: source_tail.clone(),
                        total_bytes: total,
                        confirmed_offset: transferred,
                        destination_path: local_path.to_string_lossy().to_string(),
                    },
                );
                self.complete_canceled(app_handle, task_id)?;
                return Ok(());
            }
            let read = remote_file.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            local_file.write_all(&buffer[..read]).await?;
            transferred += read as u64;
            self.progress(app_handle, task_id, transferred, total)?;
            if transferred - last_checkpoint_bytes >= CHECKPOINT_BYTES
                || now_millis().saturating_sub(last_checkpoint_at) >= CHECKPOINT_MS
            {
                let _ = write_local_checkpoint(
                    &meta_path,
                    &TransferCheckpoint {
                        task_id: task_id.to_string(),
                        source_size: total,
                        source_mtime_ms: remote_mtime_ms,
                        source_head: source_head.clone(),
                        source_tail: source_tail.clone(),
                        total_bytes: total,
                        confirmed_offset: transferred,
                        destination_path: local_path.to_string_lossy().to_string(),
                    },
                );
                last_checkpoint_bytes = transferred;
                last_checkpoint_at = now_millis();
            }
        }
        local_file.flush().await?;
        drop(local_file);
        // 提交前一次性判定：若期间被取消，保留 temp + 可信 checkpoint 供续传，不覆盖目标。
        if !self.begin_commit(app_handle, task_id)? {
            let _ = write_local_checkpoint(
                &meta_path,
                &TransferCheckpoint {
                    task_id: task_id.to_string(),
                    source_size: total,
                    source_mtime_ms: remote_mtime_ms,
                    source_head: source_head.clone(),
                    source_tail: source_tail.clone(),
                    total_bytes: total,
                    confirmed_offset: transferred,
                    destination_path: local_path.to_string_lossy().to_string(),
                },
            );
            self.complete_canceled(app_handle, task_id)?;
            return Ok(());
        }
        commit_local_temp(&temp_path, &local_path, task_id)?;
        let _ = std::fs::remove_file(&meta_path);
        self.update_task(task_id, |task| {
            task.snapshot.local_path = Some(local_path.to_string_lossy().to_string())
        })?;
        self.finish(
            app_handle,
            task_id,
            SftpTransferStatus::Completed,
            None,
            SftpCommitGuarantee::BestEffortReplace,
        )
    }

    async fn target_lock_for(
        &self,
        connection_id: &str,
        scope: &str,
        path: &str,
    ) -> Arc<tokio::sync::Mutex<()>> {
        let key = format!("{connection_id}:{scope}:{path}");
        let mut locks = self.target_locks.lock().await;
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    async fn session_for(
        &self,
        app_handle: &AppHandle,
        connection: &SshConnection,
    ) -> AppResult<Arc<CachedSftpSession>> {
        {
            let sessions = self.sessions.lock().await;
            if let Some(session) = sessions.get(&connection.id) {
                return Ok(session.clone());
            }
        }
        self.open_and_cache_session(app_handle, connection).await
    }

    async fn open_and_cache_session(
        &self,
        app_handle: &AppHandle,
        connection: &SshConnection,
    ) -> AppResult<Arc<CachedSftpSession>> {
        let (sftp, transport) = open_sftp_session(
            connection,
            self.ssh.storage(),
            app_handle.clone(),
            self.ssh.pending_trust(),
        )
        .await?;
        let session = Arc::new(CachedSftpSession {
            sftp: Arc::new(sftp),
            _transport: transport,
        });
        let mut sessions = self.sessions.lock().await;
        sessions.insert(connection.id.clone(), session.clone());
        Ok(session)
    }

    async fn drop_session(&self, connection_id: &str) {
        let mut sessions = self.sessions.lock().await;
        sessions.remove(connection_id);
    }

    /// Runs an SFTP op on a cached channel; on failure drop and retry once.
    async fn with_sftp<T, F, Fut>(
        &self,
        app_handle: &AppHandle,
        connection: &SshConnection,
        op: F,
    ) -> AppResult<T>
    where
        F: Fn(Arc<russh_sftp::client::SftpSession>) -> Fut + Send,
        Fut: std::future::Future<Output = AppResult<T>> + Send,
        T: Send,
    {
        let session = self.session_for(app_handle, connection).await?;
        match op(Arc::clone(&session.sftp)).await {
            Ok(value) => Ok(value),
            Err(first_error) => {
                // 通道可能已失效：丢弃缓存后重建再试一次
                self.drop_session(&connection.id).await;
                let session = self.open_and_cache_session(app_handle, connection).await?;
                match op(Arc::clone(&session.sftp)).await {
                    Ok(value) => Ok(value),
                    Err(_) => Err(first_error),
                }
            }
        }
    }

    fn transfer_permits_for(&self, connection_id: &str) -> AppResult<Arc<Semaphore>> {
        let mut permits = self
            .transfer_permits
            .lock()
            .map_err(|_| app_error("SFTP scheduler lock is poisoned"))?;
        Ok(permits
            .entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(2)))
            .clone())
    }

    fn connection_for(&self, connection_id: &str) -> AppResult<SshConnection> {
        self.ssh
            .runtime_connection(connection_id)?
            .map(Ok)
            .unwrap_or_else(|| {
                self.ssh
                    .storage()
                    .get_connection(connection_id)?
                    .ok_or_else(|| app_error("Connection not found"))
            })
    }

    fn task(&self, task_id: &str) -> AppResult<TaskRecord> {
        self.tasks
            .lock()
            .map_err(|_| app_error("SFTP task registry lock is poisoned"))?
            .get(task_id)
            .cloned()
            .ok_or_else(|| app_error("SFTP task not found"))
    }

    fn update_task(
        &self,
        task_id: &str,
        change: impl FnOnce(&mut TaskRecord),
    ) -> AppResult<SftpTransferTaskSnapshot> {
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| app_error("SFTP task registry lock is poisoned"))?;
        let record = tasks
            .get_mut(task_id)
            .ok_or_else(|| app_error("SFTP task not found"))?;
        change(record);
        record.snapshot.sequence += 1;
        record.snapshot.updated_at = now_millis();
        Ok(record.snapshot.clone())
    }

    fn transition(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        status: SftpTransferStatus,
    ) -> AppResult<TaskRecord> {
        let snapshot = self.update_task(task_id, |task| task.snapshot.status = status)?;
        self.emit_snapshot(app_handle, &snapshot);
        self.task(task_id)
    }

    /// 单次持锁决定是否进入提交阶段；被取消或已终态则拒绝且不改状态。
    fn begin_commit(&self, app_handle: &AppHandle, task_id: &str) -> AppResult<bool> {
        let snapshot = {
            let mut tasks = self
                .tasks
                .lock()
                .map_err(|_| app_error("SFTP task registry lock is poisoned"))?;
            let record = tasks
                .get_mut(task_id)
                .ok_or_else(|| app_error("SFTP task not found"))?;
            if can_begin_commit(&record.snapshot.status, record.canceled.load(Ordering::Acquire)) {
                record.snapshot.status = SftpTransferStatus::Committing;
                record.snapshot.sequence += 1;
                record.snapshot.updated_at = now_millis();
                Some(record.snapshot.clone())
            } else {
                None
            }
        };
        if let Some(snapshot) = &snapshot {
            self.emit_snapshot(app_handle, snapshot);
        }
        Ok(snapshot.is_some())
    }

    fn progress(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        transferred: u64,
        total: u64,
    ) -> AppResult<()> {
        let snapshot = self.update_task(task_id, |task| {
            task.snapshot.transferred_bytes = transferred;
            task.snapshot.total_bytes = Some(total);
            task.snapshot.progress = if total == 0 {
                100
            } else {
                ((transferred as f64 / total as f64) * 100.0)
                    .round()
                    .min(99.0) as u32
            };
        })?;
        self.emit_snapshot(app_handle, &snapshot);
        Ok(())
    }

    fn wait_for_conflict(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        source_path: String,
        destination_path: String,
        incoming_size: u64,
    ) -> AppResult<()> {
        let snapshot = self.update_task(task_id, |task| {
            task.snapshot.status = SftpTransferStatus::WaitingConflict;
            task.snapshot.conflict = Some(crate::models::sftp::SftpTransferConflict {
                source_path,
                destination_path: destination_path.clone(),
                existing_size: None,
                incoming_size: Some(incoming_size),
                suggested_name: Some(suggested_conflict_path(
                    task.snapshot.direction.clone(),
                    &destination_path,
                    task_id,
                )),
            });
        })?;
        self.emit_snapshot(app_handle, &snapshot);
        Ok(())
    }

    fn complete_canceled(&self, app_handle: &AppHandle, task_id: &str) -> AppResult<()> {
        self.finish(
            app_handle,
            task_id,
            SftpTransferStatus::Canceled,
            None,
            SftpCommitGuarantee::None,
        )
    }

    fn fail_task(&self, app_handle: &AppHandle, task_id: &str, attempt: u32, message: String) {
        if self
            .task(task_id)
            .map(|task| task.snapshot.attempt == attempt && !is_terminal(&task.snapshot.status))
            .unwrap_or(false)
        {
            let code = if message.contains("SOURCE_CHANGED") {
                "source-changed"
            } else {
                "io-error"
            };
            let retryable = code != "source-changed";
            let _ = self.finish_with_code(
                app_handle,
                task_id,
                SftpTransferStatus::Failed,
                Some((code.to_string(), message, retryable)),
                SftpCommitGuarantee::None,
            );
        }
    }

    fn finish(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        status: SftpTransferStatus,
        error: Option<String>,
        guarantee: SftpCommitGuarantee,
    ) -> AppResult<()> {
        self.finish_with_code(
            app_handle,
            task_id,
            status,
            error.map(|message| ("io-error".to_string(), message, true)),
            guarantee,
        )
    }

    fn finish_with_code(
        &self,
        app_handle: &AppHandle,
        task_id: &str,
        status: SftpTransferStatus,
        error: Option<(String, String, bool)>,
        guarantee: SftpCommitGuarantee,
    ) -> AppResult<()> {
        let snapshot = self.update_task(task_id, |task| {
            task.snapshot.status = status.clone();
            task.snapshot.progress = if status == SftpTransferStatus::Completed {
                100
            } else {
                task.snapshot.progress
            };
            task.snapshot.error = error.map(|(code, message, retryable)| SftpTransferError {
                code,
                message,
                retryable,
            });
            task.snapshot.commit_guarantee = guarantee;
            task.snapshot.completed_at = Some(now_millis());
        })?;
        self.emit_snapshot(app_handle, &snapshot);
        Ok(())
    }

    fn emit_snapshot(&self, app_handle: &AppHandle, snapshot: &SftpTransferTaskSnapshot) {
        let _ = app_handle.emit(
            "sftp-transfer-event",
            serde_json::json!({
                "type": "snapshot",
                "taskId": snapshot.task_id,
                "connectionId": snapshot.connection_id,
                "attempt": snapshot.attempt,
                "sequence": snapshot.sequence,
                "timestamp": snapshot.updated_at,
                "snapshot": snapshot,
            }),
        );
    }
}

fn new_snapshot(
    connection_id: String,
    batch_id: Option<String>,
    direction: SftpTransferDirection,
    name: String,
    local_path: Option<String>,
    remote_path: Option<String>,
    total_bytes: Option<u64>,
    conflict_policy: SftpConflictPolicy,
) -> SftpTransferTaskSnapshot {
    let timestamp = now_millis();
    SftpTransferTaskSnapshot {
        task_id: uuid::Uuid::new_v4().to_string(),
        batch_id,
        connection_id,
        attempt: 1,
        sequence: 0,
        direction,
        status: SftpTransferStatus::Queued,
        name,
        local_path,
        remote_path,
        total_bytes,
        transferred_bytes: 0,
        resumed_from: 0,
        progress: 0,
        conflict_policy,
        conflict: None,
        error: None,
        commit_guarantee: SftpCommitGuarantee::None,
        created_at: timestamp,
        updated_at: timestamp,
        completed_at: None,
    }
}

/// 阶段 1 规划：校验并构建上传计划，不插入任务、不发射、不 spawn。
fn plan_upload_batch(
    connection_id: &str,
    files: &[SftpLocalFileRef],
    remote_directory: &str,
    batch_id: &str,
    policy: &SftpConflictPolicy,
) -> AppResult<Vec<(SftpTransferTaskSnapshot, TransferSource)>> {
    let mut plan = Vec::with_capacity(files.len());
    for file in files {
        let local_path = file
            .path
            .clone()
            .ok_or_else(|| app_error("Desktop upload requires a local path"))?;
        let metadata = std::fs::metadata(&local_path)?;
        if !metadata.is_file() {
            return Err(app_error("Selected upload source is not a file"));
        }
        let name = Path::new(&local_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| app_error("Upload file name is invalid"))?
            .to_string();
        let remote_path = join_remote_path(remote_directory, &name);
        let snapshot = new_snapshot(
            connection_id.to_string(),
            Some(batch_id.to_string()),
            SftpTransferDirection::Upload,
            name,
            Some(local_path.clone()),
            Some(remote_path),
            Some(metadata.len()),
            policy.clone(),
        );
        plan.push((
            snapshot,
            TransferSource::Upload {
                local_path,
                remote_directory: remote_directory.to_string(),
            },
        ));
    }
    Ok(plan)
}

/// 阶段 1 规划：校验并构建下载计划，不插入任务、不发射、不 spawn。
fn plan_download_batch(
    connection_id: &str,
    remote_paths: &[String],
    destination: &str,
    batch_id: &str,
    policy: &SftpConflictPolicy,
) -> AppResult<Vec<(SftpTransferTaskSnapshot, TransferSource)>> {
    let mut plan = Vec::with_capacity(remote_paths.len());
    for remote_path in remote_paths {
        validate_remote_path(remote_path)?;
        let name = Path::new(remote_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| app_error("Remote file name is invalid"))?
            .to_string();
        let local_path = Path::new(destination)
            .join(&name)
            .to_string_lossy()
            .to_string();
        let snapshot = new_snapshot(
            connection_id.to_string(),
            Some(batch_id.to_string()),
            SftpTransferDirection::Download,
            name,
            Some(local_path),
            Some(remote_path.clone()),
            None,
            policy.clone(),
        );
        plan.push((
            snapshot,
            TransferSource::Download {
                remote_path: remote_path.clone(),
                destination: destination.to_string(),
            },
        ));
    }
    Ok(plan)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn is_terminal(status: &SftpTransferStatus) -> bool {
    matches!(
        status,
        SftpTransferStatus::Completed
            | SftpTransferStatus::Skipped
            | SftpTransferStatus::Canceled
            | SftpTransferStatus::Interrupted
            | SftpTransferStatus::Failed
            | SftpTransferStatus::HandedOff
    )
}

/// 取消请求落到各状态时的目标状态：未开始传输的直接置为 Canceled，其余进入 Canceling。
fn cancel_status(status: &SftpTransferStatus) -> SftpTransferStatus {
    match status {
        SftpTransferStatus::Queued
        | SftpTransferStatus::Checking
        | SftpTransferStatus::WaitingConflict => SftpTransferStatus::Canceled,
        _ => SftpTransferStatus::Canceling,
    }
}

/// 是否允许进入提交阶段：已请求取消、正在取消或已终态都不允许。
fn can_begin_commit(status: &SftpTransferStatus, canceled: bool) -> bool {
    !canceled && !matches!(status, SftpTransferStatus::Canceling) && !is_terminal(status)
}

fn validate_remote_path(path: &str) -> AppResult<()> {
    let trimmed = path.trim();
    if trimmed.is_empty() || trimmed == "/" || trimmed.contains('\0') {
        return Err(app_error("Invalid remote path"));
    }
    Ok(())
}

fn validate_directory_path(path: &str) -> AppResult<()> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err(app_error("Invalid remote directory"));
    }
    Ok(())
}

fn join_remote_path(parent: &str, name: &str) -> String {
    if parent == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", parent.trim_end_matches('/'), name)
    }
}

fn temp_remote_path(remote_path: &str, task_id: &str) -> String {
    let path = Path::new(remote_path);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("transfer");
    let parent = path
        .parent()
        .and_then(|value| value.to_str())
        .unwrap_or("/");
    join_remote_path(parent, &format!(".{name}.{task_id}.part"))
}

fn temp_local_path(path: &Path, task_id: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("transfer");
    path.with_file_name(format!(".{name}.{task_id}.part"))
}

fn local_meta_path(part_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.meta", part_path.to_string_lossy()))
}

fn file_mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 计算本地文件首尾最多 64KiB 的 SHA-256 十六进制指纹。
async fn hash_local_file_edges(path: &str) -> AppResult<(String, String)> {
    const EDGE: u64 = 64 * 1024;
    let meta = tokio::fs::metadata(path).await?;
    let size = meta.len();
    let mut file = tokio::fs::File::open(path).await?;
    let head_len = size.min(EDGE) as usize;
    let mut head = vec![0_u8; head_len];
    file.read_exact(&mut head).await?;
    let tail_len = size.min(EDGE) as usize;
    let mut tail = vec![0_u8; tail_len];
    if size > EDGE {
        file.seek(SeekFrom::Start(size - EDGE)).await?;
    } else {
        file.seek(SeekFrom::Start(0)).await?;
    }
    file.read_exact(&mut tail).await?;
    Ok((hex_sha256(&head), hex_sha256(&tail)))
}

fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 计算远端文件首尾最多 64KiB 的 SHA-256 十六进制指纹（用于下载续传校验）。
async fn hash_remote_file_edges(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    size: u64,
) -> AppResult<(String, String)> {
    const EDGE: u64 = 64 * 1024;
    let mut file = sftp.open(path).await?;
    let head_len = size.min(EDGE) as usize;
    let mut head = vec![0_u8; head_len];
    file.read_exact(&mut head).await?;
    let tail_len = size.min(EDGE) as usize;
    if size > EDGE {
        file.seek(SeekFrom::Start(size - EDGE)).await?;
    } else {
        file.seek(SeekFrom::Start(0)).await?;
    }
    let mut tail = vec![0_u8; tail_len];
    file.read_exact(&mut tail).await?;
    Ok((hex_sha256(&head), hex_sha256(&tail)))
}

fn write_local_checkpoint(path: &Path, checkpoint: &TransferCheckpoint) -> AppResult<()> {
    let temp = PathBuf::from(format!("{}.tmp", path.to_string_lossy()));
    let bytes = serde_json::to_vec(checkpoint).map_err(|error| app_error(error.to_string()))?;
    std::fs::write(&temp, bytes)?;
    std::fs::rename(temp, path)?;
    Ok(())
}

fn read_local_checkpoint(path: &Path) -> Option<TransferCheckpoint> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn resolve_local_resume_offset(
    temp_path: &Path,
    meta_path: &Path,
    task_id: &str,
    source_size: u64,
    source_mtime_ms: u64,
    source_head: &str,
    source_tail: &str,
) -> AppResult<u64> {
    let part_size = std::fs::metadata(temp_path).map(|meta| meta.len()).unwrap_or(0);
    let Some(checkpoint) = read_local_checkpoint(meta_path) else {
        if part_size > 0 {
            let _ = std::fs::remove_file(temp_path);
        }
        return Ok(0);
    };
    if checkpoint.task_id != task_id
        || checkpoint.source_size != source_size
        || checkpoint.source_mtime_ms != source_mtime_ms
    {
        let _ = std::fs::remove_file(temp_path);
        let _ = std::fs::remove_file(meta_path);
        return Err(app_error(
            "SOURCE_CHANGED: source file changed; restart required",
        ));
    }
    // 源指纹校验：没有可信指纹时不冒险拼接（避免续传拼接两个源版本）。
    if !checkpoint.source_head.is_empty() && !checkpoint.source_tail.is_empty() {
        if source_head.is_empty() || source_tail.is_empty() {
            // 当前无法计算指纹 => 不可校验，重启。
            let _ = std::fs::remove_file(temp_path);
            let _ = std::fs::remove_file(meta_path);
            return Ok(0);
        }
        if checkpoint.source_head != source_head || checkpoint.source_tail != source_tail {
            let _ = std::fs::remove_file(temp_path);
            let _ = std::fs::remove_file(meta_path);
            return Err(app_error(
                "SOURCE_CHANGED: source file changed; restart required",
            ));
        }
    } else {
        // 旧版 checkpoint 无指纹 => 不可校验，重启。
        let _ = std::fs::remove_file(temp_path);
        let _ = std::fs::remove_file(meta_path);
        return Ok(0);
    }
    let trusted = checkpoint
        .confirmed_offset
        .min(part_size)
        .min(source_size);
    if part_size > trusted {
        let _ = std::fs::remove_file(temp_path);
        let _ = std::fs::remove_file(meta_path);
        return Ok(0);
    }
    Ok(trusted)
}

async fn write_remote_checkpoint(
    sftp: &russh_sftp::client::SftpSession,
    meta_path: &str,
    checkpoint: &TransferCheckpoint,
) -> AppResult<()> {
    let temp = format!("{meta_path}.tmp");
    let bytes = serde_json::to_vec(checkpoint).map_err(|error| app_error(error.to_string()))?;
    let mut file = sftp
        .open_with_flags(
            &temp,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await?;
    file.write_all(&bytes).await?;
    file.shutdown().await?;
    let _ = sftp.remove_file(meta_path).await;
    sftp.rename(&temp, meta_path).await?;
    Ok(())
}

async fn read_remote_checkpoint(
    sftp: &russh_sftp::client::SftpSession,
    meta_path: &str,
) -> Option<TransferCheckpoint> {
    let mut file = sftp.open(meta_path).await.ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await.ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn backup_local_path(path: &Path, task_id: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("transfer");
    path.with_file_name(format!(".{name}.{task_id}.backup"))
}

fn commit_local_temp(temp_path: &Path, destination_path: &Path, task_id: &str) -> AppResult<()> {
    if !destination_path.exists() {
        std::fs::rename(temp_path, destination_path)?;
        return Ok(());
    }

    let backup_path = backup_local_path(destination_path, task_id);
    if backup_path.exists() {
        std::fs::remove_file(&backup_path)?;
    }
    std::fs::rename(destination_path, &backup_path)?;
    if let Err(error) = std::fs::rename(temp_path, destination_path) {
        let _ = std::fs::rename(&backup_path, destination_path);
        return Err(error.into());
    }
    if let Err(error) = std::fs::remove_file(&backup_path) {
        let _ = std::fs::remove_file(destination_path);
        let _ = std::fs::rename(&backup_path, destination_path);
        return Err(error.into());
    }
    Ok(())
}

fn next_remote_name(remote_path: &str, task_id: &str) -> String {
    let path = Path::new(remote_path);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("transfer");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let parent = path
        .parent()
        .and_then(|value| value.to_str())
        .unwrap_or("/");
    join_remote_path(
        parent,
        &format!("{stem} ({}){extension}", &task_id[..8.min(task_id.len())]),
    )
}

fn next_local_name(path: &Path, task_id: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("transfer");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    path.with_file_name(format!(
        "{stem} ({}){extension}",
        &task_id[..8.min(task_id.len())]
    ))
}

fn suggested_conflict_path(
    direction: SftpTransferDirection,
    destination_path: &str,
    task_id: &str,
) -> String {
    match direction {
        SftpTransferDirection::Upload => next_remote_name(destination_path, task_id),
        SftpTransferDirection::Download => next_local_name(Path::new(destination_path), task_id)
            .to_string_lossy()
            .to_string(),
    }
}

fn collapse_descendants(mut paths: Vec<String>) -> Vec<String> {
    paths.sort();
    paths.dedup();
    paths
        .into_iter()
        .filter(|path| !path.is_empty() && !path.contains('\0'))
        .fold(Vec::<String>::new(), |mut retained, path| {
            if !retained
                .iter()
                .any(|parent| path.starts_with(&(parent.trim_end_matches('/').to_string() + "/")))
            {
                retained.push(path);
            }
            retained
        })
}

#[cfg(test)]
mod tests {
    use super::{
        backup_local_path, cancel_status, can_begin_commit, collapse_descendants, commit_local_temp,
        join_remote_path, next_remote_name, plan_download_batch, plan_upload_batch,
        resolve_local_resume_offset, suggested_conflict_path, temp_local_path, temp_remote_path,
        write_local_checkpoint, TransferCheckpoint,
    };
    use crate::models::sftp::{
        SftpConflictPolicy, SftpLocalFileRef, SftpTransferDirection, SftpTransferStatus,
    };
    use std::fs;
    use std::path::Path;

    #[test]
    fn keeps_only_batch_delete_roots() {
        assert_eq!(
            collapse_descendants(vec![
                "/srv/logs/app.log".to_string(),
                "/srv".to_string(),
                "/tmp/cache".to_string(),
                "/srv/logs".to_string(),
            ]),
            vec!["/srv".to_string(), "/tmp/cache".to_string()]
        );
    }

    #[test]
    fn creates_hidden_sibling_part_paths() {
        assert_eq!(
            temp_remote_path("/srv/report.txt", "task-123"),
            "/srv/.report.txt.task-123.part"
        );
        assert_eq!(
            temp_local_path(Path::new("C:/Downloads/report.txt"), "task-123"),
            Path::new("C:/Downloads/.report.txt.task-123.part")
        );
    }

    #[test]
    fn generates_deterministic_rename_target() {
        assert_eq!(join_remote_path("/", "report.txt"), "/report.txt");
        assert_eq!(
            next_remote_name("/srv/report.txt", "123456789"),
            "/srv/report (12345678).txt"
        );
    }

    #[test]
    fn suggests_a_local_path_for_download_conflicts() {
        assert_eq!(
            suggested_conflict_path(
                SftpTransferDirection::Download,
                "C:\\Downloads\\report.txt",
                "123456789",
            ),
            "C:\\Downloads\\report (12345678).txt"
        );
    }

    #[test]
    fn builds_hidden_local_backup_path() {
        assert_eq!(
            backup_local_path(Path::new("C:/Downloads/report.txt"), "task-123"),
            Path::new("C:/Downloads/.report.txt.task-123.backup")
        );
    }

    #[test]
    fn commits_overwrite_by_swapping_a_backup() {
        let root =
            std::env::temp_dir().join(format!("ai-ssh-client-sftp-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("report.txt");
        let temporary = root.join(".report.txt.task.part");
        fs::write(&destination, "old").unwrap();
        fs::write(&temporary, "new").unwrap();

        commit_local_temp(&temporary, &destination, "task").unwrap();

        assert_eq!(fs::read_to_string(&destination).unwrap(), "new");
        assert!(!temporary.exists());
        assert!(!backup_local_path(&destination, "task").exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "ai-ssh-client-sftp-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn checkpoint(
        source_head: &str,
        source_tail: &str,
        confirmed_offset: u64,
    ) -> TransferCheckpoint {
        TransferCheckpoint {
            task_id: "task-1".to_string(),
            source_size: 100,
            source_mtime_ms: 42,
            source_head: source_head.to_string(),
            source_tail: source_tail.to_string(),
            total_bytes: 100,
            confirmed_offset,
            destination_path: "dest".to_string(),
        }
    }

    #[test]
    fn cancel_status_targets_pre_start_states_to_canceled() {
        assert_eq!(
            cancel_status(&SftpTransferStatus::Queued),
            SftpTransferStatus::Canceled
        );
        assert_eq!(
            cancel_status(&SftpTransferStatus::Checking),
            SftpTransferStatus::Canceled
        );
        assert_eq!(
            cancel_status(&SftpTransferStatus::WaitingConflict),
            SftpTransferStatus::Canceled
        );
        assert_eq!(
            cancel_status(&SftpTransferStatus::Transferring),
            SftpTransferStatus::Canceling
        );
        assert_eq!(
            cancel_status(&SftpTransferStatus::Committing),
            SftpTransferStatus::Canceling
        );
    }

    #[test]
    fn begin_commit_is_refused_when_canceled_or_already_finishing() {
        assert!(can_begin_commit(&SftpTransferStatus::Transferring, false));
        assert!(!can_begin_commit(&SftpTransferStatus::Transferring, true));
        assert!(!can_begin_commit(&SftpTransferStatus::Canceling, false));
        assert!(!can_begin_commit(&SftpTransferStatus::Canceled, false));
        assert!(!can_begin_commit(&SftpTransferStatus::Completed, false));
        assert!(!can_begin_commit(&SftpTransferStatus::Failed, false));
    }

    #[test]
    fn resumes_local_offset_when_fingerprint_and_meta_match() {
        let root = temp_root("resume-match");
        let temp = root.join(".report.txt.task-1.part");
        let meta = root.join(".report.txt.task-1.part.meta");
        fs::write(&temp, vec![7_u8; 100]).unwrap();
        write_local_checkpoint(&meta, &checkpoint("head-a", "tail-a", 100)).unwrap();

        let offset =
            resolve_local_resume_offset(&temp, &meta, "task-1", 100, 42, "head-a", "tail-a")
                .unwrap();

        assert_eq!(offset, 100);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_local_resume_when_source_fingerprint_differs() {
        let root = temp_root("resume-mismatch");
        let temp = root.join(".report.txt.task-1.part");
        let meta = root.join(".report.txt.task-1.part.meta");
        fs::write(&temp, vec![7_u8; 100]).unwrap();
        write_local_checkpoint(&meta, &checkpoint("head-a", "tail-a", 50)).unwrap();

        let error =
            resolve_local_resume_offset(&temp, &meta, "task-1", 100, 42, "head-b", "tail-a")
                .unwrap_err();

        assert!(error.to_string().contains("SOURCE_CHANGED"));
        assert!(!temp.exists());
        assert!(!meta.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restarts_local_resume_when_checkpoint_has_no_fingerprint() {
        let root = temp_root("resume-legacy");
        let temp = root.join(".report.txt.task-1.part");
        let meta = root.join(".report.txt.task-1.part.meta");
        fs::write(&temp, vec![7_u8; 100]).unwrap();
        write_local_checkpoint(&meta, &checkpoint("", "", 50)).unwrap();

        let offset =
            resolve_local_resume_offset(&temp, &meta, "task-1", 100, 42, "head-a", "tail-a")
                .unwrap();

        assert_eq!(offset, 0);
        assert!(!temp.exists());
        assert!(!meta.exists());
        fs::remove_dir_all(root).unwrap();
    }

    fn local_file_ref(name: &str, path: Option<std::path::PathBuf>) -> SftpLocalFileRef {
        SftpLocalFileRef {
            name: name.to_string(),
            path: path.map(|value| value.to_string_lossy().to_string()),
            r#ref: None,
            size: None,
            last_modified: None,
        }
    }

    #[test]
    fn plans_upload_batch_before_inserting_any_task() {
        let root = temp_root("plan-upload");
        let a = root.join("a.txt");
        let b = root.join("b.txt");
        fs::write(&a, b"aaaa").unwrap();
        fs::write(&b, b"bbbb").unwrap();

        let valid = vec![
            local_file_ref("a.txt", Some(a.clone())),
            local_file_ref("b.txt", Some(b.clone())),
        ];
        let plan =
            plan_upload_batch("conn", &valid, "/srv", "batch-1", &SftpConflictPolicy::Ask).unwrap();
        assert_eq!(plan.len(), 2);
        assert!(plan
            .iter()
            .all(|(snapshot, _)| snapshot.batch_id.as_deref() == Some("batch-1")));
        assert!(plan
            .iter()
            .all(|(snapshot, _)| matches!(snapshot.direction, SftpTransferDirection::Upload)));

        // 后一项缺少本地路径 => 整个批次在规划阶段就失败，且不产生任何计划。
        let invalid = vec![
            local_file_ref("a.txt", Some(a.clone())),
            local_file_ref("missing.txt", None),
        ];
        let error =
            plan_upload_batch("conn", &invalid, "/srv", "batch-1", &SftpConflictPolicy::Ask)
                .err()
                .expect("expected planning error");
        assert!(error.to_string().contains("local path"));

        // 后一项指向不存在的文件 => 同样在规划阶段失败。
        let missing = vec![
            local_file_ref("a.txt", Some(a)),
            local_file_ref("ghost.txt", Some(root.join("ghost.txt"))),
        ];
        assert!(
            plan_upload_batch("conn", &missing, "/srv", "batch-1", &SftpConflictPolicy::Ask)
                .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plans_download_batch_one_entry_per_remote_path() {
        let paths = vec!["/srv/a.txt".to_string(), "/srv/b.txt".to_string()];
        let plan = plan_download_batch(
            "conn",
            &paths,
            "C:/Downloads",
            "batch-2",
            &SftpConflictPolicy::Overwrite,
        )
        .unwrap();
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[1].0.remote_path.as_deref(), Some("/srv/b.txt"));
        assert!(plan[1]
            .0
            .local_path
            .as_deref()
            .unwrap()
            .ends_with("b.txt"));

        // 非法远端路径 => 规划失败，无计划。
        let bad = vec!["/srv/a.txt".to_string(), "/".to_string()];
        assert!(plan_download_batch(
            "conn",
            &bad,
            "C:/Downloads",
            "batch-2",
            &SftpConflictPolicy::Ask
        )
        .is_err());
    }
}
