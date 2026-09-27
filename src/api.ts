import { invoke } from "@tauri-apps/api/core";

export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  notes: string | null;
  dueAt: number | null;
  completedAt: number | null;
  position: string;
  collapsed: boolean;
  createdAt: number;
  updatedAt: number;
  tagIds: string[];
}

export interface Tag {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface Snapshot {
  tasks: Task[];
  tags: Tag[];
}

export interface LinkPreview {
  url: string;
  host: string;
  title: string | null;
  icon: string | null;
  status: "ok" | "partial" | "failed";
}

export interface ImportReport {
  tasksAdded: number;
  tasksUpdated: number;
  tasksSkipped: number;
  tagsAdded: number;
  linksAdded: number;
  repaired: number;
}

export interface AppInfo {
  version: string;
  schemaVersion: number;
  formatVersion: number;
  databasePath: string;
}

/** Only the fields the caller names are written; `null` clears a field. */
export interface TaskPatch {
  title?: string;
  description?: string | null;
  notes?: string | null;
  dueAt?: number | null;
  collapsed?: boolean;
}

// Rust returns snake_case fields under serde's default; the commands below
// rename them once so the rest of the frontend only ever sees camelCase.
function toTask(raw: Record<string, unknown>): Task {
  return {
    id: raw.id as string,
    parentId: (raw.parent_id ?? null) as string | null,
    title: raw.title as string,
    description: (raw.description ?? null) as string | null,
    notes: (raw.notes ?? null) as string | null,
    dueAt: (raw.due_at ?? null) as number | null,
    completedAt: (raw.completed_at ?? null) as number | null,
    position: raw.position as string,
    collapsed: Boolean(raw.collapsed),
    createdAt: raw.created_at as number,
    updatedAt: raw.updated_at as number,
    tagIds: (raw.tag_ids ?? []) as string[],
  };
}

function toTag(raw: Record<string, unknown>): Tag {
  return {
    id: raw.id as string,
    name: raw.name as string,
    createdAt: raw.created_at as number,
    updatedAt: raw.updated_at as number,
  };
}

function toSnapshot(raw: { tasks: Record<string, unknown>[]; tags: Record<string, unknown>[] }): Snapshot {
  return { tasks: raw.tasks.map(toTask), tags: raw.tags.map(toTag) };
}

export const api = {
  async snapshot(): Promise<Snapshot> {
    return toSnapshot(await invoke("snapshot"));
  },
  async createTask(parentId: string | null, afterId: string | null, title: string): Promise<Task> {
    return toTask(await invoke("task_create", { parentId, afterId, title }));
  },
  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    return toTask(await invoke("task_update", { id, patch }));
  },
  async setCompleted(id: string, completed: boolean): Promise<Snapshot> {
    return toSnapshot(await invoke("task_set_completed", { id, completed }));
  },
  async deleteTask(id: string): Promise<Snapshot> {
    return toSnapshot(await invoke("task_delete", { id }));
  },
  async moveTask(id: string, parentId: string | null, afterId: string | null): Promise<Snapshot> {
    return toSnapshot(await invoke("task_move", { id, parentId, afterId }));
  },
  async attachTag(taskId: string, name: string): Promise<Tag> {
    return toTag(await invoke("tag_attach", { taskId, name }));
  },
  async detachTag(taskId: string, tagId: string): Promise<void> {
    await invoke("tag_detach", { taskId, tagId });
  },
  linkPreview(url: string): Promise<LinkPreview> {
    return invoke("link_preview", { url });
  },
  exportPad(path: string): Promise<{ path: string; bytes: number }> {
    return invoke("export_pad", { path });
  },
  importPad(path: string): Promise<ImportReport> {
    return invoke("import_pad", { path });
  },
  appInfo(): Promise<AppInfo> {
    return invoke("app_info");
  },
};
