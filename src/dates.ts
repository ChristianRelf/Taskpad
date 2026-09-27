/** Due dates are stored as unix ms but compared by calendar day. */
export function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function isOverdue(dueAt: number | null, completedAt: number | null): boolean {
  if (dueAt === null || completedAt !== null) return false;
  // A task is late only once its due day is fully past, not at 00:01 on the day.
  return dueAt < startOfToday();
}

/** `2026-09-27` <-> epoch ms at local midnight, the shape `<input type=date>` wants. */
export function toInputDate(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromInputDate(value: string): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDue(ms: number): string {
  const today = startOfToday();
  const day = 86_400_000;
  const diff = Math.round((new Date(ms).setHours(0, 0, 0, 0) - today) / day);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear
    ? `${d.getDate()} ${MONTHS[d.getMonth()]}`
    : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
