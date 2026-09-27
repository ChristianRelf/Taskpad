/** View-only preferences. Nothing here is user data, so it stays out of SQLite. */
type Prefs = { hideCompleted: boolean };

const KEY = "pad.prefs.v1";
const defaults: Prefs = { hideCompleted: false };

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaults };
    return { ...defaults, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    return { ...defaults };
  }
}

let current = read();
const listeners = new Set<() => void>();

export const prefs = {
  get(): Prefs {
    return current;
  },
  set(patch: Partial<Prefs>): void {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // A full or disabled store is not worth interrupting the user for.
    }
    for (const fn of listeners) fn();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
