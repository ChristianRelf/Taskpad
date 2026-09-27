import { openUrl } from "@tauri-apps/plugin-opener";

/** Links always leave for the system browser; Pad never navigates its window. */
export async function openExternal(url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    await openUrl(parsed.toString());
  } catch {
    // A malformed link is simply not opened.
  }
}
