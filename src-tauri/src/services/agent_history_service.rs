use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::error::{app_error, AppResult};

const DB_FILE_NAME: &str = "agent-history.sqlite";

/// SQLite-backed agent conversation history store.
pub struct AgentHistoryService {
    connection: Mutex<Connection>,
}

fn data_dir() -> AppResult<PathBuf> {
    let dir = dirs::data_local_dir()
        .ok_or_else(|| app_error("Unable to locate the local application data directory"))?
        .join("ai-ssh-client");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn extract_i64(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or_default()
}

impl AgentHistoryService {
    /// Opens the SQLite database and creates the history table if needed.
    pub fn new() -> AppResult<Self> {
        let db_path = data_dir()?.join(DB_FILE_NAME);
        let connection = Connection::open(db_path)?;
        connection.execute(
            "CREATE TABLE IF NOT EXISTS agent_tasks (
                id TEXT PRIMARY KEY,
                task_json TEXT NOT NULL,
                start_time INTEGER NOT NULL,
                end_time INTEGER,
                updated_at INTEGER NOT NULL
            )",
            [],
        )?;
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated_at
             ON agent_tasks(updated_at DESC)",
            [],
        )?;

        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Inserts or updates an agent task record.
    pub fn save_task(&self, task: Value) -> AppResult<()> {
        let id = task
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| app_error("Agent task id is missing"))?;
        let start_time = extract_i64(&task, "startTime");
        let end_time = task.get("endTime").and_then(Value::as_i64);
        let updated_at = end_time.unwrap_or_else(|| chrono_like_now());
        let task_json = serde_json::to_string(&task)?;

        let connection = self
            .connection
            .lock()
            .map_err(|_| app_error("Agent history lock is poisoned"))?;
        connection.execute(
            "INSERT INTO agent_tasks (id, task_json, start_time, end_time, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
               task_json = excluded.task_json,
               start_time = excluded.start_time,
               end_time = excluded.end_time,
               updated_at = excluded.updated_at",
            params![id, task_json, start_time, end_time, updated_at],
        )?;
        Ok(())
    }

    /// Returns recent agent tasks ordered from newest to oldest.
    pub fn list_tasks(&self, limit: usize) -> AppResult<Vec<Value>> {
        let limit = limit.max(1).min(500);
        let connection = self
            .connection
            .lock()
            .map_err(|_| app_error("Agent history lock is poisoned"))?;
        let mut statement = connection.prepare(
            "SELECT task_json FROM agent_tasks ORDER BY COALESCE(end_time, start_time) DESC, updated_at DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit as i64], |row| {
            let raw: String = row.get(0)?;
            serde_json::from_str::<Value>(&raw).map_err(|err| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(err),
                )
            })
        })?;

        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row?);
        }
        Ok(tasks)
    }

    /// Clears all agent tasks from history.
    pub fn clear_tasks(&self) -> AppResult<()> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| app_error("Agent history lock is poisoned"))?;
        connection.execute("DELETE FROM agent_tasks", [])?;
        Ok(())
    }

    /// Deletes a single agent task from history.
    pub fn delete_task(&self, task_id: &str) -> AppResult<()> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| app_error("Agent history lock is poisoned"))?;
        connection.execute("DELETE FROM agent_tasks WHERE id = ?1", params![task_id])?;
        Ok(())
    }
}

fn chrono_like_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
