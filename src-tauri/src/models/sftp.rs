use serde::{Deserialize, Serialize};

/// Desktop SFTP transfer direction.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpTransferDirection {
    Upload,
    Download,
}

/// The action applied when a destination already exists.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SftpConflictPolicy {
    Ask,
    Overwrite,
    Skip,
    Rename,
}

/// Lifecycle states shared with the renderer transfer reducer.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SftpTransferStatus {
    Queued,
    Checking,
    WaitingConflict,
    Transferring,
    Canceling,
    Committing,
    Completed,
    Skipped,
    Canceled,
    Interrupted,
    Failed,
    HandedOff,
}

/// The actual destination commit guarantee achieved by a transfer.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SftpCommitGuarantee {
    AtomicCreate,
    AtomicReplace,
    BestEffortReplace,
    BrowserManaged,
    None,
}

/// A local file chosen for a desktop SFTP upload.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpLocalFileRef {
    pub name: String,
    pub path: Option<String>,
    pub r#ref: Option<String>,
    pub size: Option<u64>,
    pub last_modified: Option<u64>,
}

/// A desktop local download destination.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpLocalDestinationRef {
    pub path: Option<String>,
    pub r#ref: Option<String>,
    pub name: Option<String>,
}

/// Request used to create upload tasks.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpStartUploadRequest {
    pub connection_id: String,
    pub files: Vec<SftpLocalFileRef>,
    pub remote_directory: String,
    pub conflict_policy: Option<SftpConflictPolicy>,
}

/// Request used to create download tasks.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpStartDownloadRequest {
    pub connection_id: String,
    pub remote_paths: Vec<String>,
    pub destination: SftpLocalDestinationRef,
    pub conflict_policy: Option<SftpConflictPolicy>,
}

/// A pending user decision for an ask-mode destination conflict.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpResolveConflictRequest {
    pub task_id: String,
    pub attempt: u32,
    pub policy: SftpConflictPolicy,
    pub renamed_path: Option<String>,
    /// Apply the policy to remaining unstarted tasks in the same batch.
    #[serde(default)]
    pub apply_to_batch: bool,
}

/// A task control request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferTaskRequest {
    pub task_id: String,
}

/// A structured transfer error that is stable across desktop and Web runtimes.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

/// A destination conflict reported to the renderer.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferConflict {
    pub source_path: String,
    pub destination_path: String,
    pub existing_size: Option<u64>,
    pub incoming_size: Option<u64>,
    pub suggested_name: Option<String>,
}

/// Serializable task snapshot emitted after every meaningful state transition.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpTransferTaskSnapshot {
    pub task_id: String,
    pub batch_id: Option<String>,
    pub connection_id: String,
    pub attempt: u32,
    pub sequence: u64,
    pub direction: SftpTransferDirection,
    pub status: SftpTransferStatus,
    pub name: String,
    pub local_path: Option<String>,
    pub remote_path: Option<String>,
    pub total_bytes: Option<u64>,
    pub transferred_bytes: u64,
    pub resumed_from: u64,
    pub progress: u32,
    pub conflict_policy: SftpConflictPolicy,
    pub conflict: Option<SftpTransferConflict>,
    pub error: Option<SftpTransferError>,
    pub commit_guarantee: SftpCommitGuarantee,
    pub created_at: u64,
    pub updated_at: u64,
    pub completed_at: Option<u64>,
}

/// Response returned after task creation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpStartTransferResult {
    pub tasks: Vec<SftpTransferTaskSnapshot>,
}

/// Response returned when listing tasks.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpListTransfersResult {
    pub tasks: Vec<SftpTransferTaskSnapshot>,
}

/// A per-item result for a batch delete operation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpDeleteItemResult {
    pub path: String,
    pub success: bool,
    pub error: Option<String>,
    pub code: Option<String>,
}

/// Response returned after executing a batch delete operation.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpBatchDeleteResult {
    pub items: Vec<SftpDeleteItemResult>,
    pub deleted_count: usize,
    pub failed_count: usize,
}
