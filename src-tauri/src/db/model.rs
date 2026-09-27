use serde::{Deserialize, Serialize};

/// A task exactly as the frontend sees it. Timestamps are unix milliseconds
/// UTC; `None` on `completed_at` means open.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub notes: Option<String>,
    pub due_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub position: String,
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub tag_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Partial update. Every field is a nested Option: the outer `None` means
/// "leave alone", the inner `None` means "clear it".
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default, with = "double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub description: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub notes: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub due_at: Option<Option<i64>>,
    #[serde(default, with = "double_option")]
    pub collapsed: Option<Option<bool>>,
}

/// Distinguishes an absent JSON key from an explicit `null`.
mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(de: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(de).map(Some)
    }
}

/// Everything the UI needs for one render pass.
#[derive(Debug, Serialize)]
pub struct Snapshot {
    pub tasks: Vec<Task>,
    pub tags: Vec<Tag>,
}
