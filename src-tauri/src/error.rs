use serde::Serialize;
use thiserror::Error;

/// Application-level error that can be serialized across Tauri IPC.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Reqwest(#[from] reqwest::Error),
    #[error(transparent)]
    Keyring(#[from] keyring::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Russh(#[from] russh::Error),
    #[error(transparent)]
    RusshKey(#[from] russh::keys::Error),
    #[error(transparent)]
    Sftp(#[from] russh_sftp::client::error::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Convenient result alias for Tauri commands and services.
pub type AppResult<T> = Result<T, AppError>;

/// Creates a simple application error with a displayable message.
pub fn app_error(message: impl Into<String>) -> AppError {
    AppError::Message(message.into())
}
