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
  /**
   * Roving tabindex: the list is a single tab stop and the arrows move within
   * it, so a pad with hundreds of tasks does not become hundreds of tab stops.
   */
  private activeId: string | null = null;

  constructor(opts: ChecklistOptions) {
    this.opts = opts;
    this.list = el("div", { class: "list", role: "tree", "aria-label": "Tasks" });
    this.composer = new Composer(opts.parentId, () => this.render());
    this.element = el("div", { class: "checklist" }, this.list, this.composer.element);
    this.list.addEventListener("keydown", (ev) => this.onKeyDown(ev));
    this.list.addEventListener("focusin", (ev) => {
      const row = (ev.target as HTMLElement).closest<HTMLElement>(".row");
      if (row?.dataset.id) this.setActive(row.dataset.id);
    });
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
    if (!shown.some((n) => n.task.id === this.activeId)) {
      this.activeId = shown[0]?.task.id ?? null;
    }
    this.applyRovingTabindex();
    this.composer.render();

    if (this.focusId) {
      this.setActive(this.focusId);
      this.list.querySelector<HTMLElement>(`[data-id="${cssId(this.focusId)}"]`)?.focus();
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
      tabindex: "-1",
      "aria-level": String(depth + 1),
      "aria-selected": "false",
      style: `--depth:${depth}`,
    });
    if (hasChildren) row.setAttribute("aria-expanded", String(!task.collapsed));

    // Reorder handle. Kept in a fixed gutter so hovering never shifts the row.
    const grip = el("span", {
      class: "grip",
      role: "button",
      tabindex: "-1",
      "aria-label": `Drag to move ${labelOf(task)}`,
      title: "Drag to move. Alt+arrows also work.",
    });
    grip.appendChild(Icons.grip());
    grip.addEventListener("pointerdown", (ev) => this.beginDrag(ev, row, node));
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
          { class: "twisty", pressed: !task.collapsed, tabbable: false },
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

    // Opening has to be instant, so there is no double-click to wait out here;
    // renaming in place is F2 (or the title field once the task is open).
    body.addEventListener("click", () => this.opts.onOpen(task.id));
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
      el(
        "div",
        { class: "row-actions" },
        iconButton(Icons.plus(), `Add a subtask to ${labelOf(task)}`, () => this.opts.onOpen(task.id), {
          class: "row-action",
          tabbable: false,
        }),
        iconButton(Icons.trash(), `Delete ${labelOf(task)}`, () => this.confirmDelete(node), {
          class: "row-action",
          tabbable: false,
        }),
      ),
    );

    if (this.editingId === task.id) {
      queueMicrotask(() => this.startEdit(task, row, title));
    }
    return row;
  }

  private setActive(id: string): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.applyRovingTabindex();
  }

  private applyRovingTabindex(): void {
    const rows = this.list.querySelectorAll<HTMLElement>(".row");
    rows.forEach((row) => {
      row.tabIndex = row.dataset.id === this.activeId ? 0 : -1;
    });
    // Nothing active yet (empty list aside) still needs one way in.
    if (this.activeId === null && rows.length > 0) rows[0].tabIndex = 0;
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
      } else if (isTab(ev)) {
        ev.preventDefault();
        commit(isBackTab(ev) ? "outdent" : "indent");
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
      if (!next?.dataset.id) return;
      this.setActive(next.dataset.id);
      next.focus();
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
          this.setActive(task.parentId);
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

  // -------------------------------------------------------------- reorder

  /**
   * Pointer-driven reordering. The row under the cursor is split into three
   * zones: the top and bottom edges drop the task beside it, the middle nests
   * it inside. Drop targets inside the dragged task's own subtree are refused,
   * so a branch can never be moved under itself.
   */
  private beginDrag(ev: PointerEvent, row: HTMLElement, node: TreeNode): void {
    if (ev.button !== 0) return;
    ev.preventDefault();

    const startY = ev.clientY;
    const startX = ev.clientX;
    let active = false;
    let target: { id: string; zone: Zone } | null = null;

    const move = (e: PointerEvent) => {
      if (!active) {
        if (Math.abs(e.clientY - startY) + Math.abs(e.clientX - startX) < 4) return;
        active = true;
        row.classList.add("is-dragging");
        document.body.classList.add("is-reordering");
      }
      target = this.dropTargetAt(e.clientX, e.clientY, node.task.id);
      clearDropMarks(this.list);
      if (target) {
        this.list
          .querySelector(`[data-id="${cssId(target.id)}"]`)
          ?.classList.add(`drop-${target.zone}`);
      }
      this.autoScroll(e.clientY);
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
      row.classList.remove("is-dragging");
      document.body.classList.remove("is-reordering");
      clearDropMarks(this.list);
      if (!commit || !active || !target) return;
      this.applyDrop(node.task.id, target);
    };

    const up = () => finish(true);
    const cancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey, true);
  }

  private dropTargetAt(x: number, y: number, draggedId: string): { id: string; zone: Zone } | null {
    const under = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>(".row");
    if (!under) return null;
    const id = under.dataset.id;
    if (!id || id === draggedId) return null;
    // Refuse anything inside the moving branch.
    if (isAncestor(draggedId, id)) return null;
    return { id, zone: dropZone(y, under) };
  }

  private applyDrop(draggedId: string, target: { id: string; zone: Zone }): void {
    const node = store.node(target.id);
    if (!node) return;

    let parentId: string | null;
    let afterId: string | null;
    if (target.zone === "into") {
      parentId = target.id;
      afterId = lastChildId(node);
    } else {
      parentId = node.task.parentId;
      const siblings = store.childrenNodes(parentId);
      const at = siblings.findIndex((n) => n.task.id === target.id);
      afterId = target.zone === "after" ? target.id : (siblings[at - 1]?.task.id ?? null);
      // Dropping just below a row that is showing its children means "first
      // child", which is what the eye expects from where the line is drawn.
      if (target.zone === "after" && node.children.length > 0 && !node.task.collapsed) {
        parentId = target.id;
        afterId = null;
      }
    }
    if (afterId === draggedId) return;
    this.focusId = draggedId;
    void store.run(() => api.moveTask(draggedId, parentId, afterId));
  }

  /** Keep the pointer's row in view when dragging near an edge. */
  private autoScroll(clientY: number): void {
    const scroller = this.element.closest<HTMLElement>(".body");
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const margin = 28;
    if (clientY < rect.top + margin) scroller.scrollTop -= 10;
    else if (clientY > rect.bottom - margin) scroller.scrollTop += 10;
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
    if (isTab(ev) && this.lastCreatedId) {
      // Tab nests the *next* task under the one just added, matching how the
      // same keys work while renaming a row.
      ev.preventDefault();
      const last = store.task(this.lastCreatedId);
      if (!last) return;
      if (isBackTab(ev)) {
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

/*
 * Shift+Tab arrives as the ISO_Left_Tab keysym on X11, which this webview
 * reports as its own key rather than Tab-with-shift. Both spellings count.
 */
function isTab(ev: KeyboardEvent): boolean {
  return ev.key === "Tab" || ev.key === "ISO_Left_Tab" || ev.code === "Tab";
}

function isBackTab(ev: KeyboardEvent): boolean {
  return ev.shiftKey || ev.key === "ISO_Left_Tab";
}

type Zone = "before" | "into" | "after";

function dropZone(clientY: number, row: HTMLElement): Zone {
  const rect = row.getBoundingClientRect();
  const offset = (clientY - rect.top) / rect.height;
  if (offset < 0.3) return "before";
  if (offset > 0.7) return "after";
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
