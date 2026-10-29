/** Relative "Saved ..." wording for cached snapshots. Pure, so it is testable and never invents a time. */
export function relativeTime(fetchedAt: number, now: number): string {
  const s = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

export function staleLabelText(fetchedAt: number | null, now: number, online: boolean): string {
  const when = fetchedAt === null ? "at an unknown time" : relativeTime(fetchedAt, now);
  return `Saved ${when} · ${online ? "server unavailable" : "offline"}`;
}

/** Fixed caveat: nothing offline may suggest live weather, prices or generation (PRD 13). */
export const OFFLINE_NOTE = "Shown from the copy saved on this device. Weather, prices and anything that needs the server are as of that time, not live.";
