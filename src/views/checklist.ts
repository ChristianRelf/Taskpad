import { api, type Task } from "../api";
import { formatDue, isOverdue } from "../dates";
import { announce, clear, el, iconButton } from "../dom";
import { Icons } from "../icons";
import { prefs } from "../prefs";
import { store, type TreeNode } from "../store";

export interface ChecklistOptions {
  /** `null` renders the home checklist; an id renders that task's children. */
  parentId: string | null;
  onOpen: (id: string) => void;
}

/**
 * The vertical stack of rows. Home and the task detail view render the same
 * component, so nesting behaves identically wherever you are.
 */
export class Checklist {
  readonly element: HTMLElement;
  private list: HTMLElement;
  private composer: Composer;
  private opts: ChecklistOptions;
  /** Row to re-focus after the list is rebuilt. */
  private focusId: string | null = null;
  private editingId: string | null = null;

  constructor(opts: ChecklistOptions) {
    this.opts = opts;
    this.list = el("div", { class: "list", role: "tree", "aria-label": "Tasks" });
    this.composer = new Composer(opts.parentId, () => this.render());
    this.element = el("div", { class: "checklist" }, this.list, this.composer.element);
    this.list.addEventListener("keydown", (ev) => this.onKeyDown(ev));
  }

  setParent(parentId: string | null): void {
    if (this.opts.parentId === parentId) {
      this.render();
      return;
    }
    this.opts = { ...this.opts, parentId };
    this.composer.setParent(parentId);
    this.render();
  }

  focusComposer(): void {
    this.composer.open();
  }

  render(): void {
    const rows = store.visibleRows(this.opts.parentId);
    const hideCompleted = prefs.get().hideCompleted;
    const shown = hideCompleted ? rows.filter((r) => r.task.completedAt === null) : rows;

    clear(this.list);
    if (shown.length === 0) {
      this.list.appendChild(
        el(
          "p",
          { class: "empty" },
          rows.length === 0
            ? this.opts.parentId === null
              ? "Nothing on the pad yet."
              : "No subtasks yet."
            : "Everything here is done.",
        ),
      );
    }
    for (const node of shown) {
      this.list.appendChild(this.renderRow(node));
    }
    this.composer.render();

    if (this.focusId) {
      const row = this.list.querySelector<HTMLElement>(`[data-id="${cssId(this.focusId)}"]`);
      row?.focus();
      this.focusId = null;
    }
  }

  private renderRow(node: TreeNode): HTMLElement {
    const { task } = node;
    const done = task.completedAt !== null;
    const hasChildren = node.children.length > 0;
    const overdue = isOverdue(task.dueAt, task.completedAt);
    const depth = node.depth - (this.opts.parentId === null ? 0 : depthOf(this.opts.parentId));

    const row = el("div", {
      class: `row${done ? " is-done" : ""}`,
      "data-id": task.id,
      role: "treeitem",
      tabindex: "0",
      "aria-level": String(depth + 1),
      "aria-selected": "false",
      style: `--depth:${depth}`,
    });
    if (hasChildren) row.setAttribute("aria-expanded", String(!task.collapsed));

    // Reorder handle. Kept in a fixed gutter so hovering never shifts the row.
    const grip = iconButton(Icons.grip(), `Reorder ${labelOf(task)}`, () => {}, { class: "grip" });
    grip.setAttribute("draggable", "true");
    grip.tabIndex = -1;
    grip.addEventListener("dragstart", (ev) => {
      const dt = (ev as DragEvent).dataTransfer;
      dt?.setData("text/pad-task", task.id);
      dt?.setDragImage(row, 12, 12);
      if (dt) dt.effectAllowed = "move";
      row.classList.add("is-dragging");
      dragging = task.id;
    });
    grip.addEventListener("dragend", () => {
      row.classList.remove("is-dragging");
      dragging = null;
      clearDropMarks(this.list);
    });
    row.appendChild(grip);

    const twisty = el("span", { class: "twisty-slot" });
    if (hasChildren) {
      twisty.appendChild(
        iconButton(
          task.collapsed ? Icons.chevronRight() : Icons.chevronDown(),
          task.collapsed ? `Expand ${labelOf(task)}` : `Collapse ${labelOf(task)}`,
          () => {
            this.focusId = task.id;
            void store.run(() => api.updateTask(task.id, { collapsed: !task.collapsed }));
          },
          { class: "twisty", pressed: !task.collapsed },
        ),
      );
    }
    row.appendChild(twisty);

    const check = el("button", {
      class: "check",
      type: "button",
      role: "checkbox",
      "aria-checked": String(done),
      "aria-label": done ? `Reopen ${labelOf(task)}` : `Complete ${labelOf(task)}`,
      title: done ? "Reopen" : "Complete",
      tabindex: "-1",
    });
    check.appendChild(Icons.check());
    check.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.toggle(task);
    });
    row.appendChild(check);

    const body = el("div", { class: "row-body" });
    const title = el("div", { class: "row-title" });
    title.textContent = task.title || "Untitled";
    if (!task.title) title.classList.add("is-untitled");
    body.appendChild(title);
    if (task.description) body.appendChild(el("div", { class: "row-desc", text: task.description }));

    const meta = el("div", { class: "row-meta" });
    if (overdue) meta.appendChild(el("span", { class: "flag-overdue", text: "Overdue" }));
    if (task.dueAt !== null) {
      meta.appendChild(el("span", { class: "meta-date", text: formatDue(task.dueAt) }));
    }
    for (const tag of store.tagNames(task)) {
      meta.appendChild(el("span", { class: "chip", text: tag.name }));
    }
    if (task.notes) {
      const marker = el("span", { class: "meta-icon", title: "Has notes", "aria-label": "Has notes" });
      marker.appendChild(Icons.note());
      meta.appendChild(marker);
    }
    if (meta.childElementCount > 0) body.appendChild(meta);

    body.addEventListener("click", () => this.opts.onOpen(task.id));
    body.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.startEdit(task, row, title);
    });
    row.appendChild(body);

    if (hasChildren) {
      const percent = Math.round((node.doneLeafCount / node.leafCount) * 100);
      row.appendChild(
        el("span", {
          class: "row-percent",
          text: `${percent}%`,
          title: `${node.doneLeafCount} of ${node.leafCount} subtasks done`,
        }),
      );
    }

    row.appendChild(
      iconButton(Icons.plus(), `Add a subtask to ${labelOf(task)}`, () => {
        this.opts.onOpen(task.id);
      }, { class: "row-action" }),
    );
    row.appendChild(
      iconButton(Icons.trash(), `Delete ${labelOf(task)}`, () => this.confirmDelete(node), {
        class: "row-action",
      }),
    );

    this.wireDropTarget(row, node);
    if (this.editingId === task.id) {
      queueMicrotask(() => this.startEdit(task, row, title));
    }
    return row;
  }

  // ------------------------------------------------------------ interaction

  private toggle(task: Task): void {
    this.focusId = task.id;
    void store.run(
      () => api.setCompleted(task.id, task.completedAt === null),
      () => announce(task.completedAt === null ? "Completed" : "Reopened"),
    );
  }

  private confirmDelete(node: TreeNode): void {
    const count = countDescendants(node);
    if (count > 0) {
      const ok = window.confirm(
        `Delete "${labelOf(node.task)}" and ${count} subtask${count === 1 ? "" : "s"}?`,
      );
      if (!ok) return;
    }
    void store.run(
      () => api.deleteTask(node.task.id),
      () => announce("Deleted"),
    );
  }

  /** Replace a row's title with an input, in place. */
  private startEdit(task: Task, row: HTMLElement, title: HTMLElement): void {
    if (row.querySelector(".row-edit")) return;
    this.editingId = task.id;
    const input = el("input", {
      class: "row-edit",
      type: "text",
      value: task.title,
      "aria-label": "Task title",
    }) as HTMLInputElement;
    title.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const commit = (nextAction?: "indent" | "outdent" | "new") => {
      if (settled) return;
      settled = true;
      this.editingId = null;
      const value = input.value.trim();
      const changed = value !== task.title;
      const work: Promise<unknown>[] = [];
      if (changed) work.push(api.updateTask(task.id, { title: value }));
      void Promise.all(work).then(async () => {
        if (nextAction === "indent") await this.indent(task, 1);
        else if (nextAction === "outdent") await this.indent(task, -1);
        else if (nextAction === "new") {
          await store.refresh();
          this.composer.open();
          return;
        } else {
          this.focusId = task.id;
          await store.refresh();
        }
      });
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      this.editingId = null;
      this.focusId = task.id;
      this.render();
    };

    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit("new");
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
      } else if (ev.key === "Tab") {
        ev.preventDefault();
        commit(ev.shiftKey ? "outdent" : "indent");
      }
    });
    input.addEventListener("blur", () => commit());
  }

  /** Move a task one level deeper (under the sibling above) or shallower. */
  private async indent(task: Task, direction: 1 | -1): Promise<void> {
    const siblings = store.childrenNodes(task.parentId);
    const index = siblings.findIndex((n) => n.task.id === task.id);
    this.focusId = task.id;

    if (direction === 1) {
      const above = siblings[index - 1];
      if (!above) return; // Nothing to nest under; leave it where it is.
      await store.run(() => api.moveTask(task.id, above.task.id, lastChildId(above)));
    } else {
      if (task.parentId === null || task.parentId === this.opts.parentId) return;
      const parent = store.task(task.parentId);
      if (!parent) return;
      await store.run(() => api.moveTask(task.id, parent.parentId, parent.id));
    }
  }

  private async reorder(task: Task, direction: 1 | -1): Promise<void> {
    const siblings = store.childrenNodes(task.parentId);
    const index = siblings.findIndex((n) => n.task.id === task.id);
    const target = index + direction;
    if (target < 0 || target >= siblings.length) return;
    this.focusId = task.id;
    // Moving down lands after the neighbour; moving up lands after whatever
    // precedes it, which is `null` at the top of the list.
    const afterId =
      direction === 1 ? siblings[target].task.id : (siblings[target - 1]?.task.id ?? null);
    await store.run(() => api.moveTask(task.id, task.parentId, afterId));
  }

  private onKeyDown(ev: KeyboardEvent): void {
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".row");
    if (!row || row.querySelector(".row-edit")) return;
    const id = row.dataset.id;
    const task = id ? store.task(id) : undefined;
    if (!task) return;
    const node = store.node(task.id);

    const rows = Array.from(this.list.querySelectorAll<HTMLElement>(".row"));
    const index = rows.indexOf(row);
    const focusAt = (i: number) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i))];
      next?.focus();
    };

    switch (ev.key) {
      case "ArrowDown":
        ev.preventDefault();
        if (ev.altKey) void this.reorder(task, 1);
        else focusAt(index + 1);
        break;
      case "ArrowUp":
        ev.preventDefault();
        if (ev.altKey) void this.reorder(task, -1);
        else focusAt(index - 1);
        break;
      case "ArrowRight":
        ev.preventDefault();
        if (ev.altKey) void this.indent(task, 1);
        else if (node?.children.length && task.collapsed) {
          this.focusId = task.id;
          void store.run(() => api.updateTask(task.id, { collapsed: false }));
        } else if (node?.children.length) {
          focusAt(index + 1);
        }
        break;
      case "ArrowLeft":
        ev.preventDefault();
        if (ev.altKey) void this.indent(task, -1);
        else if (node?.children.length && !task.collapsed) {
          this.focusId = task.id;
          void store.run(() => api.updateTask(task.id, { collapsed: true }));
        } else if (task.parentId && task.parentId !== this.opts.parentId) {
          this.focusId = task.parentId;
          this.render();
        }
        break;
      case " ":
        ev.preventDefault();
        this.toggle(task);
        break;
      case "Enter":
        ev.preventDefault();
        this.opts.onOpen(task.id);
        break;
      case "F2":
        ev.preventDefault();
        this.startEdit(task, row, row.querySelector<HTMLElement>(".row-title")!);
        break;
      case "Delete":
      case "Backspace":
        ev.preventDefault();
        if (node) this.confirmDelete(node);
        break;
      default:
        break;
    }
  }

  // -------------------------------------------------------------- drag drop

  private wireDropTarget(row: HTMLElement, node: TreeNode): void {
    row.addEventListener("dragover", (ev) => {
      if (!dragging || dragging === node.task.id) return;
      if (isAncestor(dragging, node.task.id)) return; // would detach a branch
      ev.preventDefault();
      const zone = dropZone(ev as DragEvent, row);
      clearDropMarks(this.list);
      row.classList.add(`drop-${zone}`);
      if ((ev as DragEvent).dataTransfer) {
        (ev as DragEvent).dataTransfer!.dropEffect = "move";
      }
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "drop-into"));
    row.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const id = dragging;
      clearDropMarks(this.list);
      if (!id || id === node.task.id || isAncestor(id, node.task.id)) return;
      const zone = dropZone(ev as DragEvent, row);
      dragging = null;

      let parentId: string | null;
      let afterId: string | null;
      if (zone === "into") {
        parentId = node.task.id;
        afterId = lastChildId(node);
      } else {
        parentId = node.task.parentId;
        const siblings = store.childrenNodes(parentId);
        const at = siblings.findIndex((n) => n.task.id === node.task.id);
        afterId =
          zone === "after" ? node.task.id : (siblings[at - 1]?.task.id ?? null);
      }
      this.focusId = id;
      void store.run(() => api.moveTask(id, parentId, afterId));
    });
  }
}

/** The "add a task" line at the foot of a list. */
class Composer {
  readonly element: HTMLElement;
  private input: HTMLInputElement;
  private trigger: HTMLButtonElement;
  private parentId: string | null;
  private onChanged: () => void;
  private lastCreatedId: string | null = null;

  constructor(parentId: string | null, onChanged: () => void) {
    this.parentId = parentId;
    this.onChanged = onChanged;

    this.input = el("input", {
      class: "composer-input",
      type: "text",
      placeholder: "Add a task",
      "aria-label": "Add a task",
      spellcheck: "false",
    }) as HTMLInputElement;

    this.trigger = iconButton(Icons.plus(), "Add a task", () => this.open(), {
      class: "composer-trigger",
    });

    const field = el(
      "div",
      { class: "composer-field", hidden: true },
      el("span", { class: "composer-dot", "aria-hidden": "true" }),
      this.input,
    );
    this.element = el("div", { class: "composer" }, this.trigger, field);

    this.input.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    this.input.addEventListener("blur", () => {
      if (this.input.value.trim() === "") this.close();
    });
  }

  setParent(parentId: string | null): void {
    this.parentId = parentId;
    this.lastCreatedId = null;
    this.close();
  }

  render(): void {
    // Nothing data-driven here; the composer keeps its own open/closed state.
  }

  open(): void {
    (this.element.querySelector(".composer-field") as HTMLElement).hidden = false;
    this.trigger.hidden = true;
    this.input.focus();
  }

  private close(): void {
    (this.element.querySelector(".composer-field") as HTMLElement).hidden = true;
    this.trigger.hidden = false;
    this.input.value = "";
    this.lastCreatedId = null;
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.close();
      this.trigger.focus();
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      const title = this.input.value.trim();
      if (!title) {
        this.close();
        return;
      }
      this.input.value = "";
      const parentId = this.parentId;
      const afterId = this.lastCreatedId;
      void store.run(
        () => api.createTask(parentId, afterId, title),
        (task) => {
          this.lastCreatedId = task.id;
          announce(`Added ${title}`);
          this.onChanged();
          this.input.focus();
        },
      );
      return;
    }
    if (ev.key === "Tab" && this.lastCreatedId) {
      // Tab nests the *next* task under the one just added, matching how the
      // same keys work while renaming a row.
      ev.preventDefault();
      const last = store.task(this.lastCreatedId);
      if (!last) return;
      if (ev.shiftKey) {
        if (last.parentId === null || last.parentId === this.parentId) return;
        this.parentId = store.task(last.parentId)?.parentId ?? null;
      } else {
        this.parentId = last.id;
      }
      this.lastCreatedId = null;
      this.input.focus();
    }
  }
}

// ------------------------------------------------------------------ helpers

let dragging: string | null = null;

function dropZone(ev: DragEvent, row: HTMLElement): "before" | "into" | "after" {
  const rect = row.getBoundingClientRect();
  const offset = (ev.clientY - rect.top) / rect.height;
  if (offset < 0.28) return "before";
  if (offset > 0.72) return "after";
  return "into";
}

function clearDropMarks(list: HTMLElement): void {
  for (const row of list.querySelectorAll(".drop-before, .drop-after, .drop-into")) {
    row.classList.remove("drop-before", "drop-after", "drop-into");
  }
}

function isAncestor(maybeAncestor: string, id: string): boolean {
  let cursor: string | null = id;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor)) {
    if (cursor === maybeAncestor) return true;
    guard.add(cursor);
    cursor = store.task(cursor)?.parentId ?? null;
  }
  return false;
}

function lastChildId(node: TreeNode): string | null {
  return node.children.length ? node.children[node.children.length - 1].task.id : null;
}

function countDescendants(node: TreeNode): number {
  return node.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

function depthOf(id: string): number {
  return (store.node(id)?.depth ?? 0) + 1;
}

export function labelOf(task: Task): string {
  return task.title || "Untitled task";
}

function cssId(id: string): string {
  return id.replace(/["\\]/g, "\\$&");
}
