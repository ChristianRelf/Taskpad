import { api, type LinkPreview } from "../api";
import { el } from "../dom";
import { Icons } from "../icons";
import { openExternal } from "../external";

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

/** Every http(s) link in a block of notes, de-duplicated, in order. */
export function findLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    // Trailing punctuation usually belongs to the sentence, not the URL.
    const url = match[0].replace(/[.,;:!?]+$/, "");
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
  const host = el("span", { class: "embed-host", text: fallback.host });

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
    host.textContent = data.host;
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
