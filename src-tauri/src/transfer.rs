//! Export and import.
//!
//! A `.padpack` is gzipped JSON holding *records*, not a copy of the SQLite
//! file. That is deliberate: the same record shape is what a future sync would
//! push and pull, so import is already a merge rather than a restore.
//! See `docs/data-format.md`.

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;

use crate::db::{now_ms, position, SCHEMA_VERSION};
use crate::error::PadError;

pub const FORMAT: &str = "pad.pack";
pub const FORMAT_VERSION: u32 = 1;
const MAX_IMPORT_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pack {
    pub format: String,
    pub format_version: u32,
    pub schema_version: u32,
    pub app_version: String,
    pub exported_at: i64,
    pub tasks: Vec<TaskRecord>,
    pub tags: Vec<TagRecord>,
    pub task_tags: Vec<TaskTagRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub due_at: Option<i64>,
    #[serde(default)]
    pub completed_at: Option<i64>,
    #[serde(default)]
    pub position: String,
    #[serde(default)]
    pub collapsed: bool,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRecord {
    pub id: String,
    pub name: String,
    pub name_key: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTagRecord {
    pub task_id: String,
    pub tag_id: String,
    pub created_at: i64,
    #[serde(default)]
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub tasks_added: usize,
    pub tasks_updated: usize,
    pub tasks_skipped: usize,
    pub tags_added: usize,
    pub links_added: usize,
    /// Records accepted after being corrected (bad order key, missing parent,
    /// parent cycle). Surfaced so the user knows the pack was not pristine.
    pub repaired: usize,
}

// ------------------------------------------------------------------ export

pub fn build_pack(conn: &Connection) -> Result<Pack, PadError> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, title, description, notes, due_at, completed_at,
                position, collapsed, created_at, updated_at, deleted_at
         FROM tasks ORDER BY created_at",
    )?;
    let tasks = stmt
        .query_map([], |r| {
            Ok(TaskRecord {
                id: r.get(0)?,
                parent_id: r.get(1)?,
                title: r.get(2)?,
                description: r.get(3)?,
                notes: r.get(4)?,
                due_at: r.get(5)?,
                completed_at: r.get(6)?,
                position: r.get(7)?,
                collapsed: r.get::<_, i64>(8)? != 0,
                created_at: r.get(9)?,
                updated_at: r.get(10)?,
                deleted_at: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut tstmt = conn.prepare(
        "SELECT id, name, name_key, created_at, updated_at, deleted_at FROM tags ORDER BY created_at",
    )?;
    let tags = tstmt
        .query_map([], |r| {
            Ok(TagRecord {
                id: r.get(0)?,
                name: r.get(1)?,
                name_key: r.get(2)?,
                created_at: r.get(3)?,
                updated_at: r.get(4)?,
                deleted_at: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut lstmt =
        conn.prepare("SELECT task_id, tag_id, created_at, deleted_at FROM task_tags")?;
    let task_tags = lstmt
        .query_map([], |r| {
            Ok(TaskTagRecord {
                task_id: r.get(0)?,
                tag_id: r.get(1)?,
                created_at: r.get(2)?,
                deleted_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(Pack {
        format: FORMAT.to_string(),
        format_version: FORMAT_VERSION,
        schema_version: SCHEMA_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: now_ms(),
        tasks,
        tags,
        task_tags,
    })
}

pub fn write_pack(conn: &Connection, path: &Path) -> Result<u64, PadError> {
    let pack = build_pack(conn)?;
    let json = serde_json::to_vec(&pack)?;
    // Write beside the target then rename, so an interrupted export cannot
    // leave a half-written file where a good one used to be.
    let tmp = path.with_extension("padpack.part");
    {
        let file = std::fs::File::create(&tmp)?;
        let mut gz = GzEncoder::new(file, Compression::best());
        gz.write_all(&json)?;
        gz.finish()?.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(std::fs::metadata(path)?.len())
}

// ------------------------------------------------------------------ import

pub fn read_pack(path: &Path) -> Result<Pack, PadError> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > MAX_IMPORT_BYTES {
        return Err(PadError::Invalid("that file is too large to import".into()));
    }
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    // Accept plain JSON too: gzip always starts 1f 8b, so the check is exact.
    let mut head = [0u8; 2];
    let mut probe = std::fs::File::open(path)?;
    let n = probe.read(&mut head)?;
    if n == 2 && head == [0x1f, 0x8b] {
        GzDecoder::new(file)
            .take(MAX_IMPORT_BYTES)
            .read_to_end(&mut bytes)?;
    } else {
        std::io::BufReader::new(file)
            .take(MAX_IMPORT_BYTES)
            .read_to_end(&mut bytes)?;
    }

    let pack: Pack = serde_json::from_slice(&bytes)
        .map_err(|e| PadError::Invalid(format!("this is not a Pad export ({e})")))?;

    if pack.format != FORMAT {
        return Err(PadError::Invalid(format!(
            "unexpected format \"{}\"",
            pack.format.chars().take(40).collect::<String>()
        )));
    }
    if pack.format_version > FORMAT_VERSION {
        return Err(PadError::Invalid(format!(
            "this export was written by a newer version of Pad (format v{}, this build reads v{FORMAT_VERSION}). Update Pad, then import again.",
            pack.format_version
        )));
    }
    Ok(pack)
}

/// Merge a pack into the open pad.
///
/// Records are matched by id and resolved last-writer-wins on `updated_at`, so
/// importing the same pack twice is a no-op and importing an older one cannot
/// undo newer edits.
pub fn import_pack(conn: &mut Connection, pack: Pack) -> Result<ImportReport, PadError> {
    let mut report = ImportReport::default();
    let tx = conn.transaction()?;
    // A pack lists tasks in creation order, which is not necessarily parent
    // order once records have been merged from several pads. Hold the parent
    // constraint until commit so a child may land before its parent.
    tx.pragma_update(None, "defer_foreign_keys", true)?;

    for tag in &pack.tags {
        if tag.id.is_empty() {
            continue;
        }
        let existing: Option<i64> = tx
            .query_row(
                "SELECT updated_at FROM tags WHERE id = ?1",
                params![tag.id],
                |r| r.get(0),
            )
            .optional()?;
        let name = clamp(&tag.name, 48);
        let key = if tag.name_key.is_empty() {
            name.to_lowercase()
        } else {
            clamp(&tag.name_key, 48).to_lowercase()
        };
        match existing {
            Some(local) if local >= tag.updated_at => {}
            Some(_) => {
                tx.execute(
                    "UPDATE tags SET name = ?2, name_key = ?3, updated_at = ?4, deleted_at = ?5
                     WHERE id = ?1",
                    params![tag.id, name, key, tag.updated_at, tag.deleted_at],
                )?;
            }
            None => {
                // A tag with the same name may already exist under a different
                // id; keep one row and let the incoming id alias onto it.
                let clash: Option<String> = tx
                    .query_row(
                        "SELECT id FROM tags WHERE name_key = ?1",
                        params![key],
                        |r| r.get(0),
                    )
                    .optional()?;
                if clash.is_some() {
                    report.repaired += 1;
                    continue;
                }
                tx.execute(
                    "INSERT INTO tags (id, name, name_key, created_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![tag.id, name, key, tag.created_at, tag.updated_at, tag.deleted_at],
                )?;
                report.tags_added += 1;
            }
        }
    }

    // Ids present after the merge, used to validate parent links below.
    let incoming: std::collections::HashSet<&str> =
        pack.tasks.iter().map(|t| t.id.as_str()).collect();

    for task in &pack.tasks {
        if task.id.is_empty() || task.id.len() > 128 {
            report.tasks_skipped += 1;
            continue;
        }
        let mut repaired = false;
        let title = clamp(&task.title, 2000);
        let description = task.description.as_deref().map(|d| clamp(d, 2000));
        let notes = task.notes.as_deref().map(|n| clamp(n, 1_000_000));
        let mut pos = task.position.clone();
        if !position::is_valid(&pos) {
            pos = position::key_between(None, None);
            repaired = true;
        }

        // Keep a parent link only if the parent exists here or arrives with the
        // pack; otherwise the task lands at the root rather than vanishing.
        let parent = match &task.parent_id {
            Some(p) if !p.is_empty() => {
                let known = incoming.contains(p.as_str())
                    || tx
                        .query_row("SELECT 1 FROM tasks WHERE id = ?1", params![p], |_| Ok(()))
                        .optional()?
                        .is_some();
                if known {
                    Some(p.clone())
                } else {
                    repaired = true;
                    None
                }
            }
            _ => None,
        };

        let existing: Option<i64> = tx
            .query_row(
                "SELECT updated_at FROM tasks WHERE id = ?1",
                params![task.id],
                |r| r.get(0),
            )
            .optional()?;

        match existing {
            Some(local) if local >= task.updated_at => {
                report.tasks_skipped += 1;
                continue;
            }
            Some(_) => {
                tx.execute(
                    "UPDATE tasks SET parent_id = ?2, title = ?3, description = ?4, notes = ?5,
                            due_at = ?6, completed_at = ?7, position = ?8, collapsed = ?9,
                            updated_at = ?10, deleted_at = ?11
                     WHERE id = ?1",
                    params![
                        task.id, parent, title, description, notes, task.due_at,
                        task.completed_at, pos, task.collapsed as i64,
                        task.updated_at, task.deleted_at
                    ],
                )?;
                report.tasks_updated += 1;
            }
            None => {
                tx.execute(
                    "INSERT INTO tasks (id, parent_id, title, description, notes, due_at,
                            completed_at, position, collapsed, created_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        task.id, parent, title, description, notes, task.due_at,
                        task.completed_at, pos, task.collapsed as i64,
                        task.created_at, task.updated_at, task.deleted_at
                    ],
                )?;
                report.tasks_added += 1;
            }
        }
        if repaired {
            report.repaired += 1;
        }
    }

    for link in &pack.task_tags {
        let ok: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM tasks t JOIN tags g ON g.id = ?2 WHERE t.id = ?1",
                params![link.task_id, link.tag_id],
                |r| r.get(0),
            )
            .optional()?;
        if ok.is_none() {
            continue;
        }
        let changed = tx.execute(
            "INSERT INTO task_tags (task_id, tag_id, created_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(task_id, tag_id) DO UPDATE SET deleted_at = excluded.deleted_at",
            params![link.task_id, link.tag_id, link.created_at, link.deleted_at],
        )?;
        report.links_added += changed;
    }

    report.repaired += break_cycles(&tx)?;
    tx.commit()?;
    Ok(report)
}

/// A hand-edited or partially-merged pack can describe a parent loop, which
/// would hide those tasks from every view. Root the offenders instead.
fn break_cycles(tx: &rusqlite::Transaction<'_>) -> Result<usize, PadError> {
    let mut stmt = tx.prepare("SELECT id, parent_id FROM tasks WHERE deleted_at IS NULL")?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(stmt);

    let parents: std::collections::HashMap<&str, Option<&str>> = rows
        .iter()
        .map(|(id, p)| (id.as_str(), p.as_deref()))
        .collect();

    let mut fixed = 0usize;
    let now = now_ms();
    for (id, _) in &rows {
        let mut seen = std::collections::HashSet::new();
        let mut cursor = Some(id.as_str());
        while let Some(c) = cursor {
            if !seen.insert(c) {
                tx.execute(
                    "UPDATE tasks SET parent_id = NULL, updated_at = ?2 WHERE id = ?1",
                    params![id, now],
                )?;
                fixed += 1;
                break;
            }
            cursor = parents.get(c).copied().flatten();
        }
    }
    Ok(fixed)
}

fn clamp(s: &str, max_chars: usize) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .take(max_chars)
        .collect()
}
