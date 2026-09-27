use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum PadError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("{0}")]
    Io(#[from] std::io::Error),

    #[error("invalid data: {0}")]
    Invalid(String),

    #[error("task not found")]
    NotFound,

    #[error("a task cannot be moved inside itself")]
    Cycle,

    #[error("this pad was written by a newer version of Pad (schema v{found}, this build understands v{supported})")]
    SchemaTooNew { found: u32, supported: u32 },

    #[error("network error: {0}")]
    Network(String),
}

impl Serialize for PadError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<serde_json::Error> for PadError {
    fn from(e: serde_json::Error) -> Self {
        PadError::Invalid(e.to_string())
    }
}
