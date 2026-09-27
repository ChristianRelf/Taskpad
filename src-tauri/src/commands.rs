use tauri::State;

use crate::db::model::{Snapshot, Tag, Task, TaskPatch};
use crate::db::{tasks, Db};
use crate::error::PadError;
use crate::links::{self, LinkPreview};
use crate::transfer::{self, ImportReport};

type R<T> = Result<T, PadError>;

#[tauri::command]
pub fn snapshot(db: State<'_, Db>) -> R<Snapshot> {
    tasks::snapshot(&db.lock())
}

#[tauri::command]
pub fn task_create(
    db: State<'_, Db>,
    parent_id: Option<String>,
    after_id: Option<String>,
    title: String,
) -> R<Task> {
    tasks::create(
        &db.lock(),
        parent_id.as_deref(),
        after_id.as_deref(),
        &title,
    )
}

#[tauri::command]
pub fn task_update(db: State<'_, Db>, id: String, patch: TaskPatch) -> R<Task> {
    tasks::update(&db.lock(), &id, &patch)
}

#[tauri::command]
pub fn task_set_completed(db: State<'_, Db>, id: String, completed: bool) -> R<Snapshot> {
    let conn = db.lock();
    tasks::set_completed(&conn, &id, completed)?;
    tasks::snapshot(&conn)
}

#[tauri::command]
pub fn task_delete(db: State<'_, Db>, id: String) -> R<Snapshot> {
    let conn = db.lock();
    tasks::delete(&conn, &id)?;
    tasks::snapshot(&conn)
}

#[tauri::command]
pub fn task_move(
    db: State<'_, Db>,
    id: String,
    parent_id: Option<String>,
    after_id: Option<String>,
) -> R<Snapshot> {
    let conn = db.lock();
    tasks::move_task(&conn, &id, parent_id.as_deref(), after_id.as_deref())?;
    tasks::snapshot(&conn)
}

#[tauri::command]
pub fn tag_attach(db: State<'_, Db>, task_id: String, name: String) -> R<Tag> {
    tasks::attach_tag(&db.lock(), &task_id, &name)
}

#[tauri::command]
pub fn tag_detach(db: State<'_, Db>, task_id: String, tag_id: String) -> R<()> {
    tasks::detach_tag(&db.lock(), &task_id, &tag_id)
}

#[tauri::command]
pub async fn link_preview(db: State<'_, Db>, url: String) -> R<LinkPreview> {
    links::preview(db.inner(), &url).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub bytes: u64,
}

#[tauri::command]
pub fn export_pad(db: State<'_, Db>, path: String) -> R<ExportReport> {
    let path = std::path::PathBuf::from(path);
    let bytes = transfer::write_pack(&db.lock(), &path)?;
    Ok(ExportReport {
        path: path.to_string_lossy().into_owned(),
        bytes,
    })
}

#[tauri::command]
pub fn import_pad(db: State<'_, Db>, path: String) -> R<ImportReport> {
    let pack = transfer::read_pack(std::path::Path::new(&path))?;
    let mut conn = db.lock();
    transfer::import_pack(&mut conn, pack)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub schema_version: u32,
    pub format_version: u32,
    pub database_path: String,
}

#[tauri::command]
pub fn app_info(state: State<'_, crate::Paths>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: crate::db::SCHEMA_VERSION,
        format_version: transfer::FORMAT_VERSION,
        database_path: state.database.to_string_lossy().into_owned(),
    }
}
