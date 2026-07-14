use std::path::PathBuf;

use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::models::ipc::{error, success, IpcResult};

const MAX_PRIVATE_KEY_FILE_BYTES: u64 = 1024 * 1024;

fn file_path_to_path_buf(file_path: FilePath) -> Option<PathBuf> {
    PathBuf::try_from(file_path).ok()
}

/// Opens a file picker. Dialog plugin wiring is handled in a later migration step.
#[tauri::command]
pub fn select_file(
    app_handle: AppHandle,
    options: Option<serde_json::Value>,
) -> IpcResult<serde_json::Value> {
    let title = options
        .as_ref()
        .and_then(|value| value.get("title"))
        .and_then(|value| value.as_str())
        .unwrap_or("选择文件");
    let mut dialog = app_handle.dialog().file().set_title(title);

    if let Some(default_path) = options
        .as_ref()
        .and_then(|value| value.get("defaultPath"))
        .and_then(|value| value.as_str())
    {
        let default_file_name = PathBuf::from(default_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        if !default_file_name.is_empty() {
            dialog = dialog.set_file_name(default_file_name);
        }
    }

    if let Some(filters) = options
        .as_ref()
        .and_then(|value| value.get("filters"))
        .and_then(|value| value.as_array())
    {
        for filter in filters {
            if let (Some(name), Some(extensions)) = (
                filter.get("name").and_then(|value| value.as_str()),
                filter.get("extensions").and_then(|value| value.as_array()),
            ) {
                let extensions: Vec<String> = extensions
                    .iter()
                    .filter_map(|value| value.as_str().map(|value| value.to_string()))
                    .collect();
                let extension_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
                if !extension_refs.is_empty() {
                    dialog = dialog.add_filter(name, &extension_refs);
                }
            }
        }
    }

    let properties = options
        .as_ref()
        .and_then(|value| value.get("properties"))
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let pick_dir = properties.iter().any(|value| *value == "openDirectory");
    let multi = properties.iter().any(|value| *value == "multiSelections");

    let selected_path = if pick_dir {
        dialog.blocking_pick_folder()
    } else if multi {
        dialog
            .blocking_pick_files()
            .and_then(|mut files| files.drain(..).next())
    } else {
        dialog.blocking_pick_file()
    };

    match selected_path {
        Some(path) => {
            let path_buf = file_path_to_path_buf(path).unwrap_or_default();
            let file_path = path_buf.to_string_lossy().to_string();
            success(json!({
                "canceled": false,
                "filePath": file_path,
                "fileName": path_buf.file_name().and_then(|name| name.to_str()).unwrap_or_default()
            }))
        }
        None => success(json!({
            "canceled": true,
            "filePath": "",
            "fileName": ""
        })),
    }
}

/// Opens a multi-file picker dedicated to SFTP uploads.
#[tauri::command]
pub fn sftp_select_files(app_handle: AppHandle) -> IpcResult<serde_json::Value> {
    let files = app_handle
        .dialog()
        .file()
        .set_title("选择要上传的文件")
        .blocking_pick_files()
        .unwrap_or_default();
    let files = files
        .into_iter()
        .filter_map(file_path_to_path_buf)
        .filter_map(|path| {
            let metadata = std::fs::metadata(&path).ok()?;
            if !metadata.is_file() {
                return None;
            }
            Some(json!({
                "name": path.file_name().and_then(|name| name.to_str()).unwrap_or_default(),
                "path": path.to_string_lossy(),
                "size": metadata.len(),
                "lastModified": metadata.modified().ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|time| time.as_millis() as u64),
            }))
        })
        .collect::<Vec<_>>();
    success(json!({ "canceled": files.is_empty(), "files": files }))
}

/// Opens a directory picker dedicated to SFTP downloads.
#[tauri::command]
pub fn sftp_select_download_destination(app_handle: AppHandle) -> IpcResult<serde_json::Value> {
    match app_handle
        .dialog()
        .file()
        .set_title("选择下载目录")
        .blocking_pick_folder()
    {
        Some(path) => match file_path_to_path_buf(path) {
            Some(path) => success(json!({
                "canceled": false,
                "destination": {
                    "path": path.to_string_lossy(),
                    "name": path.file_name().and_then(|name| name.to_str()),
                },
            })),
            None => error("无法读取选择的下载目录"),
        },
        None => success(json!({ "canceled": true })),
    }
}

/// Reads a private key file selected by the file picker.
#[tauri::command]
pub fn read_private_key_file(file_path: String) -> IpcResult<serde_json::Value> {
    if file_path.trim().is_empty() {
        return error("私钥文件路径无效");
    }

    let path = PathBuf::from(file_path);
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(err) => return error(err.to_string()),
    };

    if !metadata.is_file() {
        return error("选择的路径不是文件");
    }

    if metadata.len() > MAX_PRIVATE_KEY_FILE_BYTES {
        return error("私钥文件过大");
    }

    match std::fs::read_to_string(path) {
        Ok(content) => success(json!({ "content": content })),
        Err(err) => error(err.to_string()),
    }
}
