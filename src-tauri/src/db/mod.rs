pub mod model;
pub mod position;
pub mod tasks;

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

use crate::error::PadError;

/// Bump when a migration is added; `MIGRATIONS` must have one entry per step.
pub const SCHEMA_VERSION: u32 = 1;

const MIGRATIONS: &[&str] = &[include_str!("../../migrations/0001_init.sql")];

pub struct Db {
    pub conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, PadError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        configure(&conn)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, PadError> {
        let conn = Connection::open_in_memory()?;
        configure(&conn)?;
        migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A poisoned lock means a previous command panicked mid-statement.
        // The connection itself is still usable, so recover rather than abort.
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn configure(conn: &Connection) -> Result<(), PadError> {
    // WAL plus a full-ish sync is what keeps the pad intact across a crash or
    // a hard power cut without paying fsync on every keystroke.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), PadError> {
    let current: u32 =
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as u32;

    if current > SCHEMA_VERSION {
        return Err(PadError::SchemaTooNew {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let step = i as u32 + 1;
        if step > current {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", step as i64)?;
        }
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
