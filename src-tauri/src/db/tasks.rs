use rusqlite::{params, Connection, OptionalExtension, Row};

use super::model::{Snapshot, Tag, Task, TaskPatch};
use super::{new_id, now_ms, position};
use crate::error::PadError;

/// Rows are tombstoned rather than removed, so every read filters on this.
const LIVE: &str = "deleted_at IS NULL";

fn row_to_task(row: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get("id")?,
        parent_id: row.get("parent_id")?,
        title: row.get("title")?,
        description: row.get("description")?,
        notes: row.get("notes")?,
        due_at: row.get("due_at")?,
        completed_at: row.get("completed_at")?,
        position: row.get("position")?,
        collapsed: row.get::<_, i64>("collapsed")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        tag_ids: Vec::new(),
    })
}

pub fn snapshot(conn: &Connection) -> Result<Snapshot, PadError> {
    let mut stmt = conn.prepare(&format!(
        "SELECT * FROM tasks WHERE {LIVE} ORDER BY parent_id, position"
    ))?;
    let mut tasks: Vec<Task> = stmt
        .query_map([], row_to_task)?
        .collect::<rusqlite::Result<_>>()?;

    // One pass over the join table beats a per-task query once the pad is big.
    let mut link = conn.prepare(&format!(
        "SELECT task_id, tag_id FROM task_tags WHERE {LIVE}"
    ))?;
    let mut by_task: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let pairs = link.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    for pair in pairs {
        let (task_id, tag_id) = pair?;
        by_task.entry(task_id).or_default().push(tag_id);
    }
    for task in &mut tasks {
        if let Some(ids) = by_task.remove(&task.id) {
            task.tag_ids = ids;
        }
    }

    let mut tstmt = conn.prepare(&format!(
        "SELECT id, name, created_at, updated_at FROM tags WHERE {LIVE} ORDER BY name COLLATE NOCASE"
    ))?;
    let tags: Vec<Tag> = tstmt
        .query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(Snapshot { tasks, tags })
}

pub fn get(conn: &Connection, id: &str) -> Result<Task, PadError> {
    conn.query_row(
        &format!("SELECT * FROM tasks WHERE id = ?1 AND {LIVE}"),
        params![id],
        row_to_task,
    )
    .optional()?
    .ok_or(PadError::NotFound)
}

/// Order key placing a new row directly after `after_id`, or at the end of the
/// sibling list when `after_id` is `None`.
fn position_after(
    conn: &Connection,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    moving_id: Option<&str>,
) -> Result<String, PadError> {
    let siblings = sibling_positions(conn, parent_id, moving_id)?;
    match after_id {
        Some(after) => {
            let at = siblings.iter().position(|(id, _)| id == after);
            match at {
                Some(i) => {
                    let before = siblings[i].1.as_str();
                    let next = siblings.get(i + 1).map(|(_, p)| p.as_str());
                    Ok(position::key_between(Some(before), next))
                }
                // `after_id` is not a sibling (it may be the row being moved
                // out of this list); append instead of failing.
                None => Ok(position::key_between(
                    siblings.last().map(|(_, p)| p.as_str()),
                    None,
                )),
            }
        }
        None => Ok(position::key_between(
            siblings.last().map(|(_, p)| p.as_str()),
            None,
        )),
    }
}

fn sibling_positions(
    conn: &Connection,
    parent_id: Option<&str>,
    exclude: Option<&str>,
) -> Result<Vec<(String, String)>, PadError> {
    let sql = format!(
        "SELECT id, position FROM tasks
         WHERE {LIVE} AND parent_id IS ?1 AND (?2 IS NULL OR id <> ?2)
         ORDER BY position"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![parent_id, exclude], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn create(
    conn: &Connection,
    parent_id: Option<&str>,
    after_id: Option<&str>,
    title: &str,
) -> Result<Task, PadError> {
    if let Some(p) = parent_id {
        // Fails loudly rather than orphaning the new row.
        get(conn, p)?;
    }
    let pos = position_after(conn, parent_id, after_id, None)?;
    let now = now_ms();
    let id = new_id();
    conn.execute(
        "INSERT INTO tasks (id, parent_id, title, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, parent_id, title.trim(), pos, now],
    )?;
    // A new open child can invalidate an already-complete parent.
    if parent_id.is_some() {
        reconcile_ancestors(conn, parent_id, now)?;
    }
    get(conn, &id)
}

pub fn update(conn: &Connection, id: &str, patch: &TaskPatch) -> Result<Task, PadError> {
    get(conn, id)?;
    let now = now_ms();
    if let Some(v) = &patch.title {
        let title = v.as_deref().unwrap_or("").trim();
        conn.execute(
            "UPDATE tasks SET title = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, title, now],
        )?;
    }
    if let Some(v) = &patch.description {
        let d = v.as_deref().map(str::trim).filter(|s| !s.is_empty());
        conn.execute(
            "UPDATE tasks SET description = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, d, now],
        )?;
    }
    if let Some(v) = &patch.notes {
        let n = v.as_deref().filter(|s| !s.is_empty());
        conn.execute(
            "UPDATE tasks SET notes = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, n, now],
        )?;
    }
    if let Some(v) = &patch.due_at {
        conn.execute(
            "UPDATE tasks SET due_at = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, v, now],
        )?;
    }
    if let Some(v) = &patch.collapsed {
        conn.execute(
            "UPDATE tasks SET collapsed = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, v.unwrap_or(false) as i64, now],
        )?;
    }
    get(conn, id)
}

/// Ids of `id` and everything beneath it, parents before children.
fn subtree_ids(conn: &Connection, id: &str) -> Result<Vec<String>, PadError> {
    let mut stmt = conn.prepare(&format!(
        "WITH RECURSIVE sub(id) AS (
             SELECT id FROM tasks WHERE id = ?1 AND {LIVE}
             UNION ALL
             SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id WHERE t.{LIVE}
         ) SELECT id FROM sub"
    ))?;
    let ids = stmt
        .query_map(params![id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(ids)
}

/// Walks up from `from`, closing a parent once all its children are closed and
/// reopening it the moment one is not. Keeps a parent from ever reading as done
/// while something under it is still open.
fn reconcile_ancestors(
    conn: &Connection,
    from: Option<&str>,
    now: i64,
) -> Result<(), PadError> {
    let mut cursor = from.map(str::to_string);
    while let Some(id) = cursor {
        let row: Option<(Option<i64>, Option<String>)> = conn
            .query_row(
                &format!("SELECT completed_at, parent_id FROM tasks WHERE id = ?1 AND {LIVE}"),
                params![&id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((completed_at, parent_id)) = row else {
            break;
        };

        let (children, open): (i64, i64) = conn.query_row(
            &format!(
                "SELECT COUNT(*), SUM(completed_at IS NULL) FROM tasks
                 WHERE parent_id = ?1 AND {LIVE}"
            ),
            params![&id],
            |r| Ok((r.get(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
        )?;

        if children > 0 {
            let should_be_complete = open == 0;
            if should_be_complete && completed_at.is_none() {
                conn.execute(
                    "UPDATE tasks SET completed_at = ?2, updated_at = ?2 WHERE id = ?1",
                    params![&id, now],
                )?;
            } else if !should_be_complete && completed_at.is_some() {
                conn.execute(
                    "UPDATE tasks SET completed_at = NULL, updated_at = ?2 WHERE id = ?1",
                    params![&id, now],
                )?;
            }
        }
        cursor = parent_id;
    }
    Ok(())
}

pub fn set_completed(conn: &Connection, id: &str, completed: bool) -> Result<(), PadError> {
    let task = get(conn, id)?;
    let now = now_ms();
    let ids = subtree_ids(conn, id)?;

    // Ticking a parent ticks everything under it; untick does the reverse.
    let mut stmt = conn.prepare(
        "UPDATE tasks SET completed_at = ?2, updated_at = ?3 WHERE id = ?1",
    )?;
    for tid in &ids {
        stmt.execute(params![tid, if completed { Some(now) } else { None }, now])?;
    }
    drop(stmt);

    reconcile_ancestors(conn, task.parent_id.as_deref(), now)?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> Result<Vec<String>, PadError> {
    let task = get(conn, id)?;
    let now = now_ms();
    let ids = subtree_ids(conn, id)?;
    {
        let mut stmt =
            conn.prepare("UPDATE tasks SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1")?;
        let mut link =
            conn.prepare("UPDATE task_tags SET deleted_at = ?2 WHERE task_id = ?1 AND deleted_at IS NULL")?;
        for tid in &ids {
            stmt.execute(params![tid, now])?;
            link.execute(params![tid, now])?;
        }
    }
    reconcile_ancestors(conn, task.parent_id.as_deref(), now)?;
    Ok(ids)
}

/// Move `id` under `new_parent_id`, positioned after `after_id`.
pub fn move_task(
    conn: &Connection,
    id: &str,
    new_parent_id: Option<&str>,
    after_id: Option<&str>,
) -> Result<Task, PadError> {
    let task = get(conn, id)?;
    if let Some(parent) = new_parent_id {
        if parent == id {
            return Err(PadError::Cycle);
        }
        get(conn, parent)?;
        // Dropping a task into its own subtree would detach that whole branch
        // from the root, so refuse before writing anything.
        if subtree_ids(conn, id)?.iter().any(|d| d == parent) {
            return Err(PadError::Cycle);
        }
    }

    let pos = position_after(conn, new_parent_id, after_id, Some(id))?;
    let now = now_ms();
    conn.execute(
        "UPDATE tasks SET parent_id = ?2, position = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, new_parent_id, pos, now],
    )?;

    // Both the old and the new branch can change completeness.
    reconcile_ancestors(conn, task.parent_id.as_deref(), now)?;
    reconcile_ancestors(conn, new_parent_id, now)?;
    get(conn, id)
}

// ---------------------------------------------------------------- tags

pub fn attach_tag(conn: &Connection, task_id: &str, name: &str) -> Result<Tag, PadError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(PadError::Invalid("tag name is empty".into()));
    }
    if name.chars().count() > 48 {
        return Err(PadError::Invalid("tag name is too long".into()));
    }
    get(conn, task_id)?;
    let key = name.to_lowercase();
    let now = now_ms();

    let existing: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT id, deleted_at FROM tags WHERE name_key = ?1",
            params![key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    let tag_id = match existing {
        Some((id, deleted)) => {
            if deleted.is_some() {
                conn.execute(
                    "UPDATE tags SET deleted_at = NULL, name = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, name, now],
                )?;
            }
            id
        }
        None => {
            let id = new_id();
            conn.execute(
                "INSERT INTO tags (id, name, name_key, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![id, name, key, now],
            )?;
            id
        }
    };

    conn.execute(
        "INSERT INTO task_tags (task_id, tag_id, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(task_id, tag_id) DO UPDATE SET deleted_at = NULL",
        params![task_id, tag_id, now],
    )?;

    conn.query_row(
        "SELECT id, name, created_at, updated_at FROM tags WHERE id = ?1",
        params![tag_id],
        |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
            })
        },
    )
    .map_err(Into::into)
}

pub fn detach_tag(conn: &Connection, task_id: &str, tag_id: &str) -> Result<(), PadError> {
    conn.execute(
        "UPDATE task_tags SET deleted_at = ?3 WHERE task_id = ?1 AND tag_id = ?2",
        params![task_id, tag_id, now_ms()],
    )?;
    Ok(())
}
