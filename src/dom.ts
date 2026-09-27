/** Minimal element helper. Pad has no framework: rows are plain DOM. */
type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Icon-only control: an icon, an accessible name, a tooltip and a real click
 * target. Every bare-icon button in Pad goes through here so none of them can
 * ship without a label.
 */
export function iconButton(
  icon: SVGElement,
  label: string,
  onClick: (ev: MouseEvent) => void,
  opts: { class?: string; pressed?: boolean; tabbable?: boolean } = {},
): HTMLButtonElement {
  const button = el("button", {
    class: `icon-button${opts.class ? " " + opts.class : ""}`,
    type: "button",
    "aria-label": label,
    title: label,
  });
  if (opts.pressed !== undefined) button.setAttribute("aria-expanded", String(opts.pressed));
  // Inside a tree, only the active row is a tab stop; its controls are reached
  // with the pointer or the row's own shortcuts.
  if (opts.tabbable === false) button.tabIndex = -1;
  button.appendChild(icon);
  button.addEventListener("click", (ev) => {
    ev.stopPropagation();
    onClick(ev);
  });
  return button;
}

/** Announce a result to screen readers without stealing focus. */
export function announce(message: string): void {
  const region = document.getElementById("live-region");
  if (!region) return;
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = message;
  }, 30);
}
