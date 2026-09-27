-- Pad schema v1
--
-- Every user-owned row carries a stable UUID, creation/modification timestamps
-- and a deletion marker, so a future sync can ship records rather than the file.

CREATE TABLE tasks (
    id           TEXT PRIMARY KEY NOT NULL,
    parent_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    title        TEXT NOT NULL DEFAULT '',
    description  TEXT,
    notes        TEXT,
    due_at       INTEGER,
    completed_at INTEGER,
    position     TEXT NOT NULL,
    collapsed    INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    deleted_at   INTEGER
);

CREATE INDEX tasks_sibling_order ON tasks(parent_id, position);
CREATE INDEX tasks_updated_at    ON tasks(updated_at);
CREATE INDEX tasks_deleted_at    ON tasks(deleted_at);

CREATE TABLE tags (
    id         TEXT PRIMARY KEY NOT NULL,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
);

CREATE TABLE task_tags (
    task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id     TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX task_tags_tag ON task_tags(tag_id);

-- Derived cache. Rebuildable from the notes text, so it is never exported.
CREATE TABLE link_cache (
    url          TEXT PRIMARY KEY NOT NULL,
    host         TEXT NOT NULL,
    title        TEXT,
    favicon      BLOB,
    favicon_mime TEXT,
    status       TEXT NOT NULL,
    fetched_at   INTEGER NOT NULL
);

CREATE TABLE meta (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
