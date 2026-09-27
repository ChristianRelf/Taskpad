import "./styles.css";
import { el, iconButton, clear } from "./dom";
import { Icons } from "./icons";
import { prefs } from "./prefs";
import { store } from "./store";
import { Checklist } from "./views/checklist";
import { Detail } from "./views/detail";
import { Menu } from "./views/menu";

type Route = { view: "home" } | { view: "task"; id: string };

class App {
  private route: Route = { view: "home" };
  private root: HTMLElement;
  private wordmark: HTMLElement;
  private percent: HTMLElement;
  private menuButton: HTMLButtonElement;
  private menu: Menu;
  private body: HTMLElement;
  private errorBar: HTMLElement;
  private checklist: Checklist;
  private detail: Detail;

  constructor(root: HTMLElement) {
    this.root = root;

    this.wordmark = el("span", { class: "wordmark", text: "Pad" });
    this.percent = el("span", { class: "overall" });
    this.menu = new Menu(() => this.render());
    this.menuButton = iconButton(Icons.menu(), "Menu", (ev) => {
      this.menu.toggle(ev.currentTarget as HTMLElement);
    }, { class: "menu-button", pressed: false });

    const bar = el(
      "header",
      { class: "topbar" },
      this.wordmark,
      el("span", { class: "topbar-spacer" }),
      this.percent,
      this.menuButton,
    );

    this.errorBar = el("div", { class: "errorbar", role: "status", hidden: true });
    this.checklist = new Checklist({ parentId: null, onOpen: (id) => this.open(id) });
    this.detail = new Detail({
      onBack: () => this.back(),
      onOpen: (id) => this.open(id),
    });
    this.body = el("main", { class: "body" });

    this.root.append(
      bar,
      this.errorBar,
      this.body,
      this.menu.element,
      el("div", { id: "live-region", class: "visually-hidden", "aria-live": "polite" }),
    );

    store.subscribe(() => this.render());
    prefs.subscribe(() => this.render());
    document.addEventListener("keydown", (ev) => this.onGlobalKey(ev));
    window.addEventListener("popstate", () => this.syncFromHistory());
  }

  async start(): Promise<void> {
    await store.refresh();
    this.syncFromHistory();
    this.render();
  }

  private open(id: string): void {
    if (!store.task(id)) return;
    this.route = { view: "task", id };
    history.pushState({ id }, "", `#/task/${encodeURIComponent(id)}`);
    this.render();
  }

  private back(): void {
    if (history.state?.id) history.back();
    else {
      this.route = { view: "home" };
      history.replaceState(null, "", "#/");
      this.render();
    }
  }

  private syncFromHistory(): void {
    const match = /^#\/task\/(.+)$/.exec(location.hash);
    const id = match ? decodeURIComponent(match[1]) : null;
    this.route = id && store.task(id) ? { view: "task", id } : { view: "home" };
    this.render();
  }

  private render(): void {
    if (store.lastError) {
      clear(this.errorBar);
      this.errorBar.append(
        el("span", { text: store.lastError }),
        iconButton(Icons.close(), "Dismiss", () => store.clearError(), { class: "errorbar-close" }),
      );
      this.errorBar.hidden = false;
    } else {
      this.errorBar.hidden = true;
    }

    // A task deleted from elsewhere should not leave a dead detail view open.
    if (this.route.view === "task" && !store.task(this.route.id)) {
      this.route = { view: "home" };
      history.replaceState(null, "", "#/");
    }

    const scope = this.route.view === "task" ? this.route.id : null;
    const stats = store.stats(scope);
    this.percent.textContent = stats.percent === null ? "" : `${stats.percent}%`;
    this.percent.title =
      stats.percent === null
        ? ""
        : `${stats.doneLeafCount} of ${stats.leafCount} tasks done`;
    this.wordmark.textContent = "Pad";

    if (this.route.view === "home") {
      if (this.body.firstChild !== this.checklist.element) {
        clear(this.body);
        this.body.appendChild(this.checklist.element);
      }
      this.checklist.setParent(null);
    } else {
      if (this.body.firstChild !== this.detail.element) {
        clear(this.body);
        this.body.appendChild(this.detail.element);
      }
      this.detail.setTask(this.route.id);
    }
  }

  private onGlobalKey(ev: KeyboardEvent): void {
    const inField =
      ev.target instanceof HTMLElement &&
      (ev.target.matches("input, textarea") || ev.target.isContentEditable);

    if (ev.key === "Escape" && !inField && !this.menu.isOpen && this.route.view === "task") {
      ev.preventDefault();
      this.back();
      return;
    }
    if (inField || ev.ctrlKey || ev.metaKey || ev.altKey) return;

    if (ev.key === "n" || ev.key === "N") {
      ev.preventDefault();
      if (this.route.view === "home") this.checklist.focusComposer();
      else this.detail.focusComposer();
    }
  }
}

const root = document.getElementById("app");
if (root) void new App(root).start();
