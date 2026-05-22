use serde::Serialize;

/// IPC result matching the existing renderer contract.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum IpcResult<T>
where
    T: Serialize,
{
    Success {
        success: bool,
        data: T,
    },
    EmptySuccess {
        success: bool,
    },
    Error {
        success: bool,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
}

/// Returns a success response with data.
pub fn success<T>(data: T) -> IpcResult<T>
where
    T: Serialize,
{
    IpcResult::Success {
        success: true,
        data,
    }
}

/// Returns a success response without data.
pub fn empty_success() -> IpcResult<()> {
    IpcResult::EmptySuccess { success: true }
}

/// Returns an error response.
pub fn error<T>(message: impl Into<String>) -> IpcResult<T>
where
    T: Serialize,
{
    IpcResult::Error {
        success: false,
        error: message.into(),
        code: None,
    }
}
