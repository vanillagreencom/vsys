import type { Proc } from "./types";

/** Prefer the oldest member whose parent is outside the scope. */
export function scopeMain(
  pids: number[],
  processes: ReadonlyMap<number, Proc>,
): Proc | undefined {
  const members = new Set(pids);
  const candidates = pids.flatMap((pid) => {
    const p = processes.get(pid);
    return p ? [p] : [];
  });
  const roots = candidates.filter((p) => !members.has(p.ppid));
  return (roots.length ? roots : candidates).sort(
    (a, b) => a.start - b.start || a.pid - b.pid,
  )[0];
}
