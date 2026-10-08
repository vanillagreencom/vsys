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
      expect(columns).toEqual(fresh.columns(width));
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
