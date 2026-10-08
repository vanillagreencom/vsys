import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { History } from "../store/history";
import { emptySnapshot, processSnapshot } from "../test/fixture";
import { bucketPeaks } from "./format";
import { Retained } from "./retained";

test("the kept window matches a fresh read as samples arrive, leave and the window changes", () => {
  // Retention shorter than the widest window, so the store drops points the
  // window would still cover.
  const c = { ...defaults(), historyHours: 40000 / 3600000 };
  const retentionMs = c.historyHours * 3600000;
  const h = new History(c);
  const kept = new Retained();
  const width = 12;
  try {
    for (let i = 0; i < 160; i++) {
      // Off every column boundary, where the two placements may round apart.
      const time = 1137 + i * 1000;
      const s = emptySnapshot(time);
      s.system.memory.MemAvailable = (i * 389) % 1000;
      s.system.pressure.cpu = { some: (i * 7) % 13, full: 0, total: 0 };
      // A process changing cgroup every few samples records a change.
      s.procs = [
        processSnapshot({
          pid: 40,
          start: 100,
          group: i % 6 < 3 ? "app.slice/x.scope" : "agents.slice/x.scope",
        }),
      ];
      h.add(s);
      const windowMs = i < 60 ? 30000 : i < 110 ? 60000 : 20000;
      kept.read(h, time, windowMs, retentionMs);
      const columns = kept.columns(width);
      const fresh = new Retained().read(h, time, windowMs, retentionMs);
      expect(kept.points).toEqual(h.window(time, windowMs));
      expect(kept.events).toEqual(h.events(time, windowMs));
      const again = fresh.columns(width);
      expect(columns.start).toBe(again.start);
      expect(columns.columns).toEqual(again.columns);
      for (const field of ["memory", "pressure"] as const)
        expect(columns.columns.map((x) => x?.peaks[field] ?? null)).toEqual(
          bucketPeaks(
            kept.points,
            columns.start,
            columns.start + windowMs,
            width,
            (p) => p[field],
          ),
        );
    }
    expect(kept.events.length).toBeGreaterThan(0);
  } finally {
    h.close();
  }
});

test("a clock that steps back and recovers keeps only the window's changes", () => {
  const c = defaults();
  const h = new History(c);
  const windowMs = 300000;
  const retentionMs = c.historyHours * 3600000;
  try {
    for (let time = 1000; time <= 402000; time += 1000) {
      const s = emptySnapshot(time);
      // A process changing cgroup every sample records a change in each.
      s.procs = [
        processSnapshot({
          pid: 40,
          start: 100,
          group:
            (time / 1000) % 2 ? "app.slice/x.scope" : "agents.slice/x.scope",
        }),
      ];
      h.add(s);
    }
    const kept = new Retained();
    kept.read(h, 402000, windowMs, retentionMs);
    kept.read(h, 5000, windowMs, retentionMs);
    expect(kept.events.length).toBeGreaterThan(0);
    kept.read(h, 402000, windowMs, retentionMs);
    expect(kept.points).toEqual(h.window(402000, windowMs));
    expect(kept.events).toEqual(h.events(402000, windowMs));
  } finally {
    h.close();
  }
});

test("a sample on a column boundary at an epoch time lands in the column its cursor marks", () => {
  const c = defaults();
  const h = new History(c);
  // 1791471600000 * 126 / 300000 is a whole number: the sample opens a column.
  const time = 1791471600000;
  const width = 126;
  try {
    h.add(emptySnapshot(time));
    const { columns, column } = new Retained()
      .read(h, time, 300000, c.historyHours * 3600000)
      .columns(width);
    expect(column(time)).toBe(width - 1);
    expect(columns[width - 1]?.last).toBe(time);
  } finally {
    h.close();
  }
});
