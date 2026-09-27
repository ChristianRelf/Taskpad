import { api, type LinkPreview } from "../api";
import { el } from "../dom";
import { Icons } from "../icons";
import { openExternal } from "../external";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/** Trailing sentence punctuation belongs to the prose, not to the link. */
function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "");
}

/** Every http(s) link in a block of notes, de-duplicated, in order. */
export function findLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= 12) break; // one notes field should not fan out forever
  }
  return out;
}

const cache = new Map<string, Promise<LinkPreview>>();

function preview(url: string): Promise<LinkPreview> {
  let pending = cache.get(url);
  if (!pending) {
    pending = api.linkPreview(url).catch(() => fallbackPreview(url));
    cache.set(url, pending);
  }
  return pending;
}

function fallbackPreview(url: string): LinkPreview {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Leave the raw string; it is still more use than nothing.
  }
  return { url, host, title: null, icon: null, status: "failed" };
}

/**
 * Compact embed: favicon, title (or hostname), and the domain. No thumbnail,
 * no page text. Renders immediately from the URL and fills in when metadata
 * arrives, so a slow or failed lookup never blocks the note.
 */
export function linkEmbed(url: string): HTMLElement {
  const fallback = fallbackPreview(url);

  const favicon = el("span", { class: "embed-icon", "aria-hidden": "true" });
  favicon.appendChild(Icons.globe());

  const title = el("span", { class: "embed-title", text: fallback.host || url });
  const host = el("span", { class: "embed-host" });

  const anchor = el(
    "button",
    {
      class: "embed",
      type: "button",
      title: url,
      "aria-label": `Open ${fallback.host || url} in your browser`,
    },
    favicon,
    el("span", { class: "embed-text" }, title, host),
  );
  anchor.addEventListener("click", () => void openExternal(url));

  void preview(url).then((data) => {
    title.textContent = data.title ?? data.host ?? url;
    // With no title the hostname is already the heading; printing it twice
    // just makes the row noisier.
    host.textContent = data.title ? data.host : "";
    anchor.setAttribute("aria-label", `Open ${data.title ?? data.host} in your browser`);
    if (data.icon) {
      const img = el("img", { src: data.icon, alt: "", width: "14", height: "14" });
      img.addEventListener("error", () => {
        // Keep the outline globe rather than a broken-image box.
        img.remove();
        favicon.appendChild(Icons.globe());
      });
      favicon.replaceChildren(img);
    }
    if (data.status === "failed") anchor.classList.add("is-unreached");
  });

  return anchor;
}

/**
 * Notes as the reader sees them: plain text with each link swapped for its
 * embed. The text itself is never rewritten -- this is a view over it.
 */
export function renderNotes(text: string): HTMLElement {
  const view = el("div", { class: "notes-view" });
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrl(match[0]);
    if (start > cursor) view.appendChild(document.createTextNode(text.slice(cursor, start)));
    view.appendChild(linkEmbed(url));
    cursor = start + url.length;
  }
  if (cursor < text.length) view.appendChild(document.createTextNode(text.slice(cursor)));
  return view;
}
