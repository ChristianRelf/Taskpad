import { openUrl } from "@tauri-apps/plugin-opener";
import { store } from "./store";

/** Links always leave for the system browser; Pad never navigates its window. */
export async function openExternal(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return; // not a link at all
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  try {
    await openUrl(parsed.toString());
  } catch (err) {
    // A machine with no browser handler would otherwise swallow the click.
    store.reportError(`Could not open ${parsed.hostname}: ${String(err)}`);
  }
}
