# Pad data format

Pad stores everything locally in SQLite and exports it as records, not as a
copy of the database file. This document describes both, and what a future
cloud sync would build on.

Nothing here requires an account, and nothing is sent anywhere. The only
network requests Pad makes are link previews for URLs the user has typed.

## Where the data lives

| Platform | Path |
| --- | --- |
| Linux | `~/.local/share/com.pad.checklist/pad.sqlite3` |
| macOS | `~/Library/Application Support/com.pad.checklist/pad.sqlite3` |
| Windows | `%APPDATA%\com.pad.checklist\pad.sqlite3` |

The exact path for the running build is shown under **Menu → About Pad**.

The database runs in WAL mode with `synchronous=NORMAL`, so an abrupt shutdown
loses at most the last in-flight transaction and never corrupts the file. Every
write is a single statement or a single transaction; there is no long-lived
open transaction to lose.

## Schema versioning

The schema version is the SQLite `user_version` pragma. On startup Pad applies
every migration numbered above the stored version, then writes the new number.
Migrations are append-only: `src-tauri/migrations/NNNN_name.sql`, one file per
step, each added to `MIGRATIONS` in `src-tauri/src/db/mod.rs`, with
`SCHEMA_VERSION` bumped to match.

Opening a database written by a *newer* Pad fails with a clear message rather
than migrating downwards, so an older build cannot damage a newer pad.

Current version: **1**.

## Tables

### `tasks`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT | UUIDv4. Stable for the life of the task, on any device. |
| `parent_id` | TEXT NULL | The explicit parent. `NULL` means a top-level task. |
| `title` | TEXT | Trimmed on write. |
| `description` | TEXT NULL | One line. |
| `notes` | TEXT NULL | Long plain text. Links live in here as text. |
| `due_at` | INTEGER NULL | Unix milliseconds, UTC. |
| `completed_at` | INTEGER NULL | Unix milliseconds. `NULL` means open. |
| `position` | TEXT | Fractional order key, see below. |
| `collapsed` | INTEGER | View state, 0 or 1. |
| `created_at` | INTEGER | Unix milliseconds. |
| `updated_at` | INTEGER | Unix milliseconds. Bumped on every field change. |
| `deleted_at` | INTEGER NULL | Tombstone. Rows are never removed. |

### `tags`

`id` (UUID), `name`, `name_key` (lower-cased, unique), `created_at`,
`updated_at`, `deleted_at`. Tag identity is the name: attaching a tag that
already exists reuses its row rather than creating a duplicate.

### `task_tags`

`task_id`, `tag_id`, `created_at`, `deleted_at`. Primary key on the pair, so
the same tag cannot be attached twice. Detaching sets `deleted_at` rather than
deleting, so the removal can be replicated.

### `link_cache`

`url` (primary key), `host`, `title`, `favicon` (BLOB), `favicon_mime`,
`status`, `fetched_at`.

This one is **derived, not owned**. Everything in it can be rebuilt from the
URLs in `tasks.notes`, so it is never exported and never synced. It is capped
at 400 rows (oldest evicted) and each favicon at 48 kB, which bounds the cache
at a few megabytes in the worst case. A successful entry is re-fetched after
14 days; a failed one after an hour, so a link added while offline fixes
itself.

### `meta`

Reserved key/value space for future use (device id, last sync cursor).

## Ordering

Sibling order is a base-62 string, not an integer. Inserting between two rows
computes a key strictly between their two keys, so only the new row is written
and no other row has to be renumbered.

```
key_between("V", "W")  ->  "Vs"
key_between("V", "Vs") ->  "VV"
```

This matters for sync more than for speed: renumbering a list would turn one
user action into N conflicting updates. With fractional keys, two devices that
insert into the same list produce two independent records that merge cleanly,
and ties break deterministically on `(position, id)`.

## Completion

A task's completion is stored only on that task. Everything else is derived:

- **Percentages** count *leaves* — tasks with no children of their own. A
  parent contributes nothing of its own, so a deeply nested branch is not
  counted twice at every level. A task with no subtasks has no percentage.
- **Ticking a parent** completes its whole subtree; unticking reopens it.
- **Roll-up** runs on the way back out: a parent closes once its last child
  closes, and reopens the moment any child reopens or a new open child is
  added. A parent can therefore never read as done while work sits under it.

## Export format: `.padpack`

A `.padpack` is **gzipped JSON** holding records. Plain, uncompressed JSON is
also accepted on import, which makes the format easy to inspect:

```sh
gunzip -c pad-2026-09-27.padpack | jq .
```

```jsonc
{
  "format": "pad.pack",
  "formatVersion": 1,
  "schemaVersion": 1,
  "appVersion": "0.1.0",
  "exportedAt": 1774608000000,
  "tasks": [
    {
      "id": "9f1c…",
      "parentId": null,
      "title": "Groceries",
      "description": null,
      "notes": null,
      "dueAt": null,
      "completedAt": null,
      "position": "V",
      "collapsed": false,
      "createdAt": 1774608000000,
      "updatedAt": 1774608000000,
      "deletedAt": null
    }
  ],
  "tags": [
    { "id": "3b7a…", "name": "home", "nameKey": "home",
      "createdAt": 0, "updatedAt": 0, "deletedAt": null }
  ],
  "taskTags": [
    { "taskId": "9f1c…", "tagId": "3b7a…", "createdAt": 0, "deletedAt": null }
  ]
}
```

Notes:

- **Tombstones are included.** A deleted task ships as a record with
  `deletedAt` set, so importing a newer pack can propagate the deletion.
- **No favicons, no cached page titles.** Those are rebuildable.
- **No duplicated task data.** Each task appears exactly once; the hierarchy is
  carried by `parentId` alone, never by nesting the same task inside a parent.
- The export is written to a temporary file and renamed into place, so an
  interrupted export cannot overwrite a good one with a partial file.

## Import

Import is a **merge**, not a restore. That is deliberate: it is the same
operation a sync would perform, so the merge path is exercised every time
anyone imports.

1. The file is size-capped (256 MB) and sniffed for the gzip magic bytes.
2. `format` must be `pad.pack`. A `formatVersion` higher than this build
   understands is refused with a message telling the user to update Pad. A
   lower one is accepted; fields added later default rather than fail.
3. Records are matched by `id` and resolved **last-writer-wins on
   `updatedAt`**. A record that is older than the local copy is skipped, so
   importing an old export cannot undo newer edits, and importing the same
   file twice changes nothing.
4. Strings are length-capped and stripped of control characters.
5. Foreign keys are deferred for the duration of the import, so a child may
   appear in the file before its parent.
6. Records are **repaired rather than dropped** where possible, and the count
   is reported back:
   - an invalid or missing `position` gets a fresh order key;
   - a `parentId` naming a task that exists neither locally nor in the pack is
     cleared, so the task lands at the top level instead of disappearing;
   - a parent cycle is broken by rooting one of the tasks involved, so no
     branch can become unreachable;
   - a tag whose name already exists under a different id is folded into the
     existing tag.

The import report names how many tasks were added, updated, skipped as already
current, and how many records needed repair.

## What a cloud sync would add

The storage layer is already record-shaped, so the pieces still missing are the
transport and the conflict policy, not the data model:

- a device id and a `last_synced_at` cursor in `meta`;
- a pull of records with `updated_at` greater than the cursor, merged with the
  same last-writer-wins rule `import_pack` already implements;
- a push of local records with `updated_at` greater than the cursor;
- optionally, per-field timestamps instead of per-row, if field-level merge
  turns out to be worth the extra width.

Because ordering uses fractional keys and deletions are tombstones, neither
reordering nor deleting requires rewriting neighbouring rows — so a sync moves
the rows that actually changed and nothing else.
