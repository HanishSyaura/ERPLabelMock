/**
 * Plant days. The plant works in the server's local time zone (the same
 * convention the machine dashboard uses for "today"). DATE columns hold the
 * calendar day at UTC midnight, so a day key "2026-11-20" maps to one value.
 */
const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day of a moment, "YYYY-MM-DD". */
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Day key of a DATE column value. */
export const dateColumnKey = (d: Date) => d.toISOString().slice(0, 10);

/** DATE column value for a day key. */
export const dateColumn = (key: string) => new Date(`${key}T00:00:00.000Z`);

/** Local start (inclusive) and end (exclusive) of a day key. */
export function dayRange(key: string) {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return { start: new Date(y, m - 1, d), end: new Date(y, m - 1, d + 1) };
}

/** Day key n days after another. */
export function addDays(key: string, n: number) {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return dayKey(new Date(y, m - 1, d + n));
}

export const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
