import { api, type Snapshot, type Tag, type Task } from "./api";

export interface TreeNode {
  task: Task;
  depth: number;
  children: TreeNode[];
  /** Leaves beneath this node, or 1 for a leaf. Never double-counts a branch. */
  leafCount: number;
  doneLeafCount: number;
}

export interface Stats {
  leafCount: number;
  doneLeafCount: number;
  /** 0-100, or null when there is nothing to measure. */
  percent: number | null;
}

type Listener = () => void;

class Store {
  tasks: Task[] = [];
  tags: Tag[] = [];
  private byId = new Map<string, Task>();
  private childrenOf = new Map<string | null, Task[]>();
  private nodes = new Map<string, TreeNode>();
  private roots: TreeNode[] = [];
  private listeners = new Set<Listener>();
  /** Last error from a command, shown once then cleared. */
  lastError: string | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  apply(snapshot: Snapshot): void {
    this.tasks = snapshot.tasks;
    this.tags = snapshot.tags;
    this.reindex();
    this.emit();
  }

  private reindex(): void {
    this.byId = new Map(this.tasks.map((t) => [t.id, t]));
    this.childrenOf = new Map();
    for (const task of this.tasks) {
      const key = task.parentId;
      // A parent that is missing (mid-import, say) would strand its children;
      // treat those as roots so nothing becomes unreachable.
      const bucket = key !== null && this.byId.has(key) ? key : null;
      const list = this.childrenOf.get(bucket);
      if (list) list.push(task);
      else this.childrenOf.set(bucket, [task]);
    }
    for (const list of this.childrenOf.values()) {
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    }
    this.nodes = new Map();
    this.roots = this.buildLevel(null, 0);
  }

  private buildLevel(parentId: string | null, depth: number): TreeNode[] {
    const out: TreeNode[] = [];
    for (const task of this.childrenOf.get(parentId) ?? []) {
      const children = this.buildLevel(task.id, depth + 1);
      let leafCount = 0;
      let doneLeafCount = 0;
      if (children.length === 0) {
        leafCount = 1;
        doneLeafCount = task.completedAt !== null ? 1 : 0;
      } else {
        for (const child of children) {
          leafCount += child.leafCount;
          doneLeafCount += child.doneLeafCount;
        }
      }
      const node: TreeNode = { task, depth, children, leafCount, doneLeafCount };
      this.nodes.set(task.id, node);
      out.push(node);
    }
    return out;
  }

  rootNodes(): TreeNode[] {
    return this.roots;
  }

  node(id: string): TreeNode | undefined {
    return this.nodes.get(id);
  }

  task(id: string): Task | undefined {
    return this.byId.get(id);
  }

  childrenNodes(parentId: string | null): TreeNode[] {
    if (parentId === null) return this.roots;
    return this.nodes.get(parentId)?.children ?? [];
  }

  tag(id: string): Tag | undefined {
    return this.tags.find((t) => t.id === id);
  }

  tagNames(task: Task): Tag[] {
    return task.tagIds.map((id) => this.tag(id)).filter((t): t is Tag => Boolean(t));
  }

  /** Ancestors of `id`, outermost first. */
  path(id: string): Task[] {
    const out: Task[] = [];
    let cursor = this.byId.get(id)?.parentId ?? null;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor)) {
      guard.add(cursor);
      const task = this.byId.get(cursor);
      if (!task) break;
      out.unshift(task);
      cursor = task.parentId;
    }
    return out;
  }

  /** Progress over the leaves under `parentId` (the whole pad when null). */
  stats(parentId: string | null): Stats {
    const nodes = this.childrenNodes(parentId);
    let leafCount = 0;
    let doneLeafCount = 0;
    for (const node of nodes) {
      leafCount += node.leafCount;
      doneLeafCount += node.doneLeafCount;
    }
    return {
      leafCount,
      doneLeafCount,
      percent: leafCount === 0 ? null : Math.round((doneLeafCount / leafCount) * 100),
    };
  }

  /** Rows in display order, skipping anything under a collapsed parent. */
  visibleRows(parentId: string | null): TreeNode[] {
    const out: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        out.push(node);
        if (!node.task.collapsed) walk(node.children);
      }
    };
    walk(this.childrenNodes(parentId));
    return out;
  }

  async refresh(): Promise<void> {
    this.apply(await api.snapshot());
  }

  /**
   * Run a command and fold the result back in. Errors surface in the UI rather
   * than failing silently, and state is re-read so the view can never drift
   * from what is actually stored.
   */
  async run<T>(fn: () => Promise<T>, onResult?: (value: T) => void): Promise<T | null> {
    try {
      const value = await fn();
      // A command that works clears whatever failed last; a stale banner is
      // worse than none.
      this.lastError = null;
      if (isSnapshot(value)) this.apply(value);
      else await this.refresh();
      onResult?.(value);
      return value;
    } catch (err) {
      this.reportError(String(err instanceof Error ? err.message : err));
      return null;
    }
  }

  reportError(message: string): void {
    this.lastError = message;
    this.emit();
  }

  clearError(): void {
    if (this.lastError === null) return;
    this.lastError = null;
    this.emit();
  }
}

function isSnapshot(value: unknown): value is Snapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as Snapshot).tasks) &&
    Array.isArray((value as Snapshot).tags)
  );
}

export const store = new Store();
