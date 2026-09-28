import { api, type Task } from "../api";
import { formatDue, fromInputDate, isOverdue, toInputDate } from "../dates";
import { announce, clear, el, iconButton } from "../dom";
import { Icons } from "../icons";
import { store } from "../store";
import { Checklist, labelOf } from "./checklist";
import { renderNotes } from "./links";

export interface DetailOptions {
  onBack: () => void;
  onOpen: (id: string) => void;
}

/** An opened task: its own fields, then its child checklist. */
export class Detail {
  readonly element: HTMLElement;
  private header: HTMLElement;
  private fields: HTMLElement;
  private checklist: Checklist;
  private opts: DetailOptions;
  private taskId: string | null = null;
  /** Suppresses a re-render while the user is mid-edit in a field. */
  private editing = false;

  constructor(opts: DetailOptions) {
    this.opts = opts;
    this.header = el("div", { class: "detail-header" });
    this.fields = el("div", { class: "detail-fields" });
    this.checklist = new Checklist({ parentId: null, onOpen: opts.onOpen });
    this.element = el(
      "div",
      { class: "detail" },
      this.header,
      this.fields,
      el("div", { class: "detail-sub" }, this.checklist.element),
    );
  }

  focusComposer(): void {
    this.checklist.focusComposer();
  }

  setTask(id: string): void {
    if (id !== this.taskId) this.editing = false;
    this.taskId = id;
    this.checklist.setParent(id);
    this.render();
  }

  render(): void {
    const task = this.taskId ? store.task(this.taskId) : undefined;
    if (!task) return;
    this.renderHeader(task);
    if (!this.editing) this.renderFields(task);
    this.checklist.render();
  }

  private renderHeader(task: Task): void {
    clear(this.header);
    this.header.appendChild(
      iconButton(Icons.back(), "Back", () => this.opts.onBack(), { class: "detail-back" }),
    );

    const trail = el("div", { class: "breadcrumb" });
    const path = store.path(task.id);
    const crumbs: (string | null)[] = [null, ...path.map((p) => p.id)];
    crumbs.forEach((id, i) => {
      if (i > 0) trail.appendChild(el("span", { class: "crumb-sep", "aria-hidden": "true" }, "/"));
      const label = id === null ? "Pad" : labelOf(store.task(id)!);
      const button = el("button", { class: "crumb", type: "button", title: label }, label);
      button.addEventListener("click", () => (id === null ? this.opts.onBack() : this.opts.onOpen(id)));
      trail.appendChild(button);
    });
    this.header.appendChild(trail);

    const node = store.node(task.id);
    if (node && node.children.length > 0) {
      const percent = Math.round((node.doneLeafCount / node.leafCount) * 100);
      this.header.appendChild(
        el("span", {
          class: "detail-percent",
          text: `${percent}%`,
          title: `${node.doneLeafCount} of ${node.leafCount} subtasks done`,
        }),
      );
    }
    this.header.appendChild(
      iconButton(Icons.trash(), `Delete ${labelOf(task)}`, () => this.confirmDelete(task), {
        class: "detail-action",
      }),
    );
  }

  private renderFields(task: Task): void {
    clear(this.fields);
    const done = task.completedAt !== null;

    // ---- title line, with the same checkbox affordance as a row
    const check = el("button", {
      class: "check check-lg",
      type: "button",
      role: "checkbox",
      "aria-checked": String(done),
      "aria-label": done ? "Reopen this task" : "Complete this task",
      title: done ? "Reopen" : "Complete",
    });
    check.appendChild(Icons.check());
    check.addEventListener("click", () =>
      void store.run(
        () => api.setCompleted(task.id, !done),
        () => announce(done ? "Reopened" : "Completed"),
      ),
    );

    const title = el("textarea", {
      class: `detail-title${done ? " is-done" : ""}`,
      rows: "1",
      placeholder: "Untitled task",
      "aria-label": "Title",
      spellcheck: "false",
    }) as HTMLTextAreaElement;
    title.value = task.title;
    this.bindField(title, (value) => ({ title: value.replace(/\s+/g, " ").trim() }));
    // Enter in a one-line title should commit, not insert a newline.
    title.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        title.blur();
      }
    });

    this.fields.appendChild(el("div", { class: "detail-title-row" }, check, title));

    // ---- one-line description
    const description = el("textarea", {
      class: "detail-desc",
      rows: "1",
      placeholder: "Add a description",
      "aria-label": "Description",
    }) as HTMLTextAreaElement;
    description.value = task.description ?? "";
    this.bindField(description, (value) => {
      const trimmed = value.replace(/\s+/g, " ").trim();
      return { description: trimmed === "" ? null : trimmed };
    });
    description.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        description.blur();
      }
    });
    this.fields.appendChild(description);

    this.fields.appendChild(this.renderMeta(task));
    this.fields.appendChild(this.renderNotes(task));

    // Sizing a textarea needs layout, so every field is grown only once the
    // whole block is in the document.
    for (const field of this.fields.querySelectorAll("textarea")) {
      this.autoGrow(field);
    }
  }

  private renderMeta(task: Task): HTMLElement {
    const meta = el("div", { class: "detail-meta" });
    const overdue = isOverdue(task.dueAt, task.completedAt);

    // ---- due date
    const dateInput = el("input", {
      type: "date",
      class: "date-input",
      "aria-label": "Due date",
      value: toInputDate(task.dueAt),
    }) as HTMLInputElement;
    dateInput.addEventListener("change", () => {
      void store.run(() => api.updateTask(task.id, { dueAt: fromInputDate(dateInput.value) }));
    });

    const dueWrap = el("div", { class: `meta-item${task.dueAt === null ? " is-empty" : ""}` });
    const dueIcon = el("span", { class: "meta-icon", "aria-hidden": "true" });
    dueIcon.appendChild(Icons.calendar());
    dueWrap.appendChild(dueIcon);
    dueWrap.appendChild(
      el("span", {
        class: "meta-label",
        text: task.dueAt === null ? "Add a due date" : formatDue(task.dueAt),
      }),
    );
    if (overdue) dueWrap.appendChild(el("span", { class: "flag-overdue", text: "Overdue" }));
    dueWrap.appendChild(dateInput);
    if (task.dueAt !== null) {
      dueWrap.appendChild(
        iconButton(Icons.close(), "Clear due date", () => {
          void store.run(() => api.updateTask(task.id, { dueAt: null }));
        }, { class: "meta-clear" }),
      );
    }
    meta.appendChild(dueWrap);

    // ---- tags
    const tags = el("div", { class: "meta-item meta-tags" });
    const tagIcon = el("span", { class: "meta-icon", "aria-hidden": "true" });
    tagIcon.appendChild(Icons.tag());
    tags.appendChild(tagIcon);

    for (const tag of store.tagNames(task)) {
      const chip = el("span", { class: "chip chip-removable" }, tag.name);
      chip.appendChild(
        iconButton(Icons.close(), `Remove tag ${tag.name}`, () => {
          void store.run(() => api.detachTag(task.id, tag.id));
        }, { class: "chip-remove" }),
      );
      tags.appendChild(chip);
    }

    const tagInput = el("input", {
      class: "tag-input",
      type: "text",
      placeholder: task.tagIds.length ? "Add tag" : "Add tags",
      "aria-label": "Add a tag",
      list: "pad-tags",
      maxlength: "48",
    }) as HTMLInputElement;
    tagInput.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const name = tagInput.value.trim();
      if (!name) return;
      tagInput.value = "";
      void store.run(() => api.attachTag(task.id, name));
    });
    tags.appendChild(tagInput);

    const datalist = el("datalist", { id: "pad-tags" });
    for (const tag of store.tags) datalist.appendChild(el("option", { value: tag.name }));
    tags.appendChild(datalist);

    meta.appendChild(tags);
    return meta;
  }

  /**
   * Notes read as text with embedded links, and become a plain textarea the
   * moment they are clicked. The stored value is always the raw text.
   */
  private renderNotes(task: Task): HTMLElement {
    const wrap = el("div", { class: "detail-notes" });
    const notes = el("textarea", {
      class: "notes-input",
      rows: "3",
      placeholder: "Notes",
      "aria-label": "Notes",
      hidden: true,
    }) as HTMLTextAreaElement;
    notes.value = task.notes ?? "";

    // A group rather than a button: the embeds inside it are buttons of their
    // own, and nesting those inside one would be nonsense to a screen reader.
    const view = el("div", { class: "notes-view-wrap", tabindex: "0", role: "group" });
    const paint = () => {
      clear(view);
      if (notes.value.trim() === "") {
        view.appendChild(el("span", { class: "notes-placeholder", text: "Notes" }));
        view.setAttribute("aria-label", "Notes. Press Enter to write some.");
      } else {
        view.appendChild(renderNotes(notes.value));
        view.setAttribute("aria-label", "Notes. Press Enter to edit.");
      }
    };
    paint();

    const edit = (atEnd: boolean) => {
      view.hidden = true;
      notes.hidden = false;
      this.autoGrow(notes);
      notes.focus();
      if (atEnd) notes.setSelectionRange(notes.value.length, notes.value.length);
    };
    view.addEventListener("click", (ev) => {
      // Clicking an embed opens the link; clicking the prose starts editing.
      if ((ev.target as HTMLElement).closest(".embed")) return;
      edit(true);
    });
    view.addEventListener("keydown", (ev) => {
      // Only when the group itself has focus; an embed handles its own keys.
      if (ev.target !== view) return;
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        edit(true);
      }
    });

    this.bindField(notes, (value) => ({ notes: value === "" ? null : value }));
    notes.addEventListener("blur", () => {
      notes.hidden = true;
      view.hidden = false;
      paint();
    });

    wrap.appendChild(view);
    wrap.appendChild(notes);
    return wrap;
  }

  // ------------------------------------------------------------- plumbing

  /** Save on blur, and debounce-save while typing so nothing is lost. */
  private bindField(
    field: HTMLTextAreaElement,
    toPatch: (value: string) => Parameters<typeof api.updateTask>[1],
  ): void {
    let timer: number | undefined;
    let lastSaved = field.value;

    const save = () => {
      window.clearTimeout(timer);
      if (field.value === lastSaved) return;
      lastSaved = field.value;
      const id = this.taskId;
      if (!id) return;
      void store.run(() => api.updateTask(id, toPatch(field.value)));
    };

    field.addEventListener("focus", () => {
      this.editing = true;
    });
    field.addEventListener("input", () => {
      this.autoGrow(field);
      window.clearTimeout(timer);
      timer = window.setTimeout(save, 600);
    });
    field.addEventListener("blur", () => {
      this.editing = false;
      save();
    });
  }

  private autoGrow(field: HTMLTextAreaElement): void {
    field.style.height = "auto";
    // scrollHeight is 0 for a detached node; the CSS min-height covers that
    // case so a field can never collapse out of sight.
    if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px`;
  }

  private confirmDelete(task: Task): void {
    const node = store.node(task.id);
    const count = node ? countAll(node.children) : 0;
    if (count > 0) {
      const ok = window.confirm(
        `Delete "${labelOf(task)}" and ${count} subtask${count === 1 ? "" : "s"}?`,
      );
      if (!ok) return;
    }
    void store.run(
      () => api.deleteTask(task.id),
      () => {
        announce("Deleted");
        this.opts.onBack();
      },
    );
  }
}

function countAll(nodes: { children: unknown[] }[]): number {
  return nodes.reduce(
    (sum, n) => sum + 1 + countAll(n.children as { children: unknown[] }[]),
    0,
  );
}
