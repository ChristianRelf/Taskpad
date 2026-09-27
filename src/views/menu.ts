import { save, open, message } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { announce, clear, el } from "../dom";
import { Icons, type IconName } from "../icons";
import { prefs } from "../prefs";
import { store } from "../store";

interface Item {
  icon: IconName;
  label: string;
  hint?: string;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
}

/** The single menu behind the icon at the top right. */
export class Menu {
  readonly element: HTMLElement;
  private panel: HTMLElement;
  private opener: HTMLElement | null = null;
  private onClose: () => void;

  constructor(onClose: () => void) {
    this.onClose = onClose;
    this.panel = el("div", { class: "menu-panel", role: "menu", "aria-label": "Pad menu" });
    this.element = el("div", { class: "menu-layer", hidden: true }, this.panel);
    this.element.addEventListener("click", (ev) => {
      if (ev.target === this.element) this.close();
    });
    document.addEventListener("keydown", (ev) => {
      if (!this.element.hidden && ev.key === "Escape") {
        ev.preventDefault();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  toggle(opener: HTMLElement): void {
    if (this.isOpen) this.close();
    else this.open(opener);
  }

  open(opener: HTMLElement): void {
    this.opener = opener;
    this.render();
    this.element.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    this.panel.querySelector<HTMLElement>("button:not([disabled])")?.focus();
  }

  close(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.opener?.setAttribute("aria-expanded", "false");
    this.opener?.focus();
    this.onClose();
  }

  private render(): void {
    clear(this.panel);
    const hideCompleted = prefs.get().hideCompleted;

    const groups: Item[][] = [
      [
        {
          icon: "check",
          label: hideCompleted ? "Show completed tasks" : "Hide completed tasks",
          checked: hideCompleted,
          onSelect: () => {
            prefs.set({ hideCompleted: !hideCompleted });
            this.close();
          },
        },
      ],
      [
        { icon: "download", label: "Export pad…", onSelect: () => void this.export() },
        { icon: "upload", label: "Import pad…", onSelect: () => void this.import() },
      ],
      [
        { icon: "keyboard", label: "Keyboard shortcuts", onSelect: () => this.showShortcuts() },
        { icon: "info", label: "About Pad", onSelect: () => void this.showAbout() },
      ],
      [
        {
          icon: "account",
          label: "Account",
          hint: "Coming later",
          disabled: true,
        },
      ],
    ];

    groups.forEach((group, index) => {
      if (index > 0) this.panel.appendChild(el("div", { class: "menu-sep", role: "separator" }));
      for (const item of group) this.panel.appendChild(this.renderItem(item));
    });

    this.panel.appendChild(
      el("p", { class: "menu-foot" }, "Pad keeps everything on this computer."),
    );
  }

  private renderItem(item: Item): HTMLElement {
    const button = el("button", {
      class: "menu-item",
      type: "button",
      role: item.checked === undefined ? "menuitem" : "menuitemcheckbox",
      disabled: item.disabled,
      "aria-disabled": item.disabled ? "true" : null,
      "aria-checked": item.checked === undefined ? null : String(item.checked),
    });
    const icon = el("span", { class: "menu-icon", "aria-hidden": "true" });
    icon.appendChild(Icons[item.icon]());
    button.appendChild(icon);
    button.appendChild(el("span", { class: "menu-label", text: item.label }));
    if (item.hint) button.appendChild(el("span", { class: "menu-hint", text: item.hint }));
    if (item.onSelect) button.addEventListener("click", item.onSelect);
    return button;
  }

  private async export(): Promise<void> {
    this.close();
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await save({
      title: "Export pad",
      defaultPath: `pad-${stamp}.padpack`,
      filters: [{ name: "Pad export", extensions: ["padpack"] }],
    });
    if (!path) return;
    const result = await store.run(() => api.exportPad(path));
    if (result) {
      announce("Pad exported");
      await message(`Exported ${formatBytes(result.bytes)} to\n${result.path}`, {
        title: "Export complete",
      });
    }
  }

  private async import(): Promise<void> {
    this.close();
    const picked = await open({
      title: "Import pad",
      multiple: false,
      directory: false,
      filters: [{ name: "Pad export", extensions: ["padpack", "json"] }],
    });
    if (!picked || Array.isArray(picked)) return;

    const report = await store.run(() => api.importPad(picked));
    if (!report) return;
    await store.refresh();
    announce("Pad imported");

    const lines = [
      `${report.tasksAdded} task${report.tasksAdded === 1 ? "" : "s"} added`,
      `${report.tasksUpdated} updated`,
      `${report.tasksSkipped} already up to date`,
    ];
    if (report.repaired > 0) {
      lines.push(`${report.repaired} record${report.repaired === 1 ? "" : "s"} repaired on the way in`);
    }
    await message(lines.join("\n"), { title: "Import complete" });
  }

  private showShortcuts(): void {
    this.close();
    const rows: [string, string][] = [
      ["Enter", "Add the typed task, ready for the next"],
      ["Tab / Shift+Tab", "Nest the task deeper or shallower"],
      ["↑ / ↓", "Move between tasks"],
      ["Alt+↑ / Alt+↓", "Reorder within the list"],
      ["Alt+← / Alt+→", "Outdent or indent"],
      ["Space", "Complete or reopen"],
      ["Enter on a task", "Open it"],
      ["F2 or double-click", "Rename in place"],
      ["← / →", "Collapse or expand"],
      ["Delete", "Delete the task"],
      ["Escape", "Back, or close what is open"],
    ];
    showSheet(
      "Keyboard",
      el(
        "dl",
        { class: "shortcuts" },
        ...rows.flatMap(([keys, what]) => [
          el("dt", {}, el("kbd", { text: keys })),
          el("dd", { text: what }),
        ]),
      ),
    );
  }

  private async showAbout(): Promise<void> {
    this.close();
    const info = await api.appInfo();
    showSheet(
      "About Pad",
      el(
        "dl",
        { class: "shortcuts about" },
        el("dt", { text: "Version" }),
        el("dd", { text: info.version }),
        el("dt", { text: "Schema" }),
        el("dd", { text: `v${info.schemaVersion}` }),
        el("dt", { text: "Export format" }),
        el("dd", { text: `pad.pack v${info.formatVersion}` }),
        el("dt", { text: "Stored at" }),
        el("dd", { class: "path", text: info.databasePath }),
      ),
    );
  }
}

/** A small centred panel used for the shortcut and about screens. */
function showSheet(title: string, body: HTMLElement): void {
  const close = el("button", {
    class: "icon-button",
    type: "button",
    "aria-label": "Close",
    title: "Close",
  });
  close.appendChild(Icons.close());

  const sheet = el(
    "div",
    { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    el("div", { class: "sheet-head" }, el("h2", { text: title }), close),
    body,
  );
  const layer = el("div", { class: "menu-layer" }, sheet);

  const dismiss = () => {
    layer.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      dismiss();
    }
  };
  close.addEventListener("click", dismiss);
  layer.addEventListener("click", (ev) => {
    if (ev.target === layer) dismiss();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(layer);
  close.focus();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
