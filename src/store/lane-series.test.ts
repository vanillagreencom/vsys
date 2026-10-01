import { expect, spyOn, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, fixture, laneSnapshot } from "../test/fixture";
import { History } from "./history";
import type { LaneSample } from "./lane-series";

test("lane charts keep brief spikes across checkpoints and update their cache", async () => {
  const h = new History(defaults());
  const id = laneSnapshot().id;
  try {
    for (let i = 0; i < 601; i++) {
      const s = emptySnapshot(1000 + i * 1000);
      s.lanes =
        i === 400
          ? []
          : [
              laneSnapshot({
                cpu: i === 301 ? 99 : 0,
                memoryPressure: i === 302 ? 50 : 0,
                ioPressure: i === 303 ? 25 : 0,
              }),
            ];
      h.add(s);
    }
    const read = async (end: number, durationMs: number) => {
      const series = (await h.laneWindows([id], end, durationMs)).get(id);
      if (!series) throw new Error("the store answered without the lane");
      return series;
    };
    const series = await read(601000, 86400000);
    expect(series).toHaveLength(601);
    expect(series[301].cpu).toBe(99);
    expect(series[302].memoryPressure).toBe(50);
    expect(series[303].ioPressure).toBe(25);
    expect(series[400].rss).toBeNull();
    series[0].cpu = 700;
    const next = emptySnapshot(602000);
    next.lanes = [laneSnapshot({ cpu: 20 })];
    h.add(next);
    expect((await read(602000, 86400000))[0].cpu).toBe(0);
    expect((await read(602000, 1000)).at(-1)?.cpu).toBe(20);
  } finally {
    h.close();
  }
});
test("reopened history loads complete lane series without duplicating concurrent requests", async () => {
  const f = fixture();
  const c = { ...f.config, persistence: true };
  const now = Date.now();
  const id = laneSnapshot().id;
  try {
    const first = new History(c);
    for (let i = 0; i < 130; i++) {
      const s = emptySnapshot(now + i * 1000);
      s.lanes = [laneSnapshot({ cpu: i === 65 ? 99 : 0 })];
      first.add(s);
    }
    first.close();
    const reopened = new History(c);
    try {
      const [a, b] = await Promise.all([
        reopened.laneWindows([id], now + 129000, 86400000),
        reopened.laneWindows([id], now + 129000, 86400000),
      ]).then((both) => both.map((series) => series.get(id)));
      expect(a).toHaveLength(130);
      expect(b).toHaveLength(130);
      expect(a?.[65].cpu).toBe(99);
      expect(b).toEqual(a);
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
  // A margin, because this case writes 130 samples to SQLite and reads them
  // back: it takes a third of a second alone and about five seconds inside the
  // full suite, where the other files are competing for the same disk. Against
  // the default five seconds that is no margin at all, and the case has failed
  // on timing rather than on what it asserts. Nothing here is slow on purpose;
  // what is asserted is the data, never the time.
}, 30000);
test("one read of many stored lanes decompresses each stored row once, and keeps only live lanes", async () => {
  const f = fixture();
  const c = { ...f.config, persistence: true };
  const now = Date.now();
  // Forty lanes, which is the Agents list on a machine running that many
  // agents. A pass per lane decompresses every row forty times.
  const ids = Array.from({ length: 40 }, (_, n) => `agents.slice/${n}.scope`);
  const rows = 30;
  const end = now + (rows - 1) * 1000;
  try {
    const first = new History(c);
    for (let i = 0; i < rows; i++) {
      const s = emptySnapshot(now + i * 1000);
      s.lanes = ids.map((id, n) => laneSnapshot({ id, cpu: i + n }));
      first.add(s);
    }
    first.close();
    // Reopened, the archive is empty, so every row is read back from SQLite.
    const reopened = new History(c);
    try {
      // biome-ignore lint/complexity/useLiteralKeys: reads a private field
      const stored = () => reopened["stored"];
      const spy = spyOn(Bun, "gunzipSync");
      const decompressed: number[] = [];
      let series = new Map<string, LaneSample[]>();
      try {
        // Half the lanes first, then all of them, as scrolling the list does:
        // the second read walks the rows once for the twenty it adds, and the
        // twenty it holds take nothing more.
        await reopened.laneWindows(ids.slice(0, 20), end, 86400000);
        decompressed.push(spy.mock.calls.length);
        series = await reopened.laneWindows(ids, end, 86400000);
        decompressed.push(spy.mock.calls.length);
        // Asked again, as a list asks when its newest bucket rolls over.
        await reopened.laneWindows(ids, end, 86400000);
        decompressed.push(spy.mock.calls.length);
      } finally {
        spy.mockRestore();
      }
      expect(decompressed).toEqual([rows, 2 * rows, 2 * rows]);
      for (const [n, id] of ids.entries())
        expect(series.get(id)?.map((x) => x.cpu)).toEqual(
          Array.from({ length: rows }, (_, i) => i + n),
        );
      // A shorter window lets go of the stored rows it no longer covers.
      await reopened.laneWindows(ids, end, 10000);
      expect(
        Math.min(
          ...[...(stored()?.lanes.values() ?? [])].flatMap((lane) =>
            lane.map((x) => x.time),
          ),
        ),
      ).toBe(end - 10000);
      // A lane that ends leaves the stored lanes.
      const next = emptySnapshot(end + 1000);
      next.lanes = [laneSnapshot({ id: ids[0], cpu: 0 })];
      reopened.add(next);
      expect([...(stored()?.lanes.keys() ?? [])]).toEqual([ids[0]]);
      // Once the window starts after the last stored row it reads only the
      // archive, and the stored series go.
      for (let i = 2; i <= 12; i++) {
        const s = emptySnapshot(end + i * 1000);
        s.lanes = [laneSnapshot({ id: ids[0], cpu: 0 })];
        reopened.add(s);
      }
      await reopened.laneWindows([ids[0]], end + 12000, 10000);
      expect(stored()).toBeUndefined();
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
  // A margin, for the reason the case above gives.
}, 30000);
test("the list and the detail reading one window length share the stored rows", async () => {
  const f = fixture();
  const c = { ...f.config, persistence: true };
  const now = Date.now();
  const id = laneSnapshot().id;
  const windowMs = 60000;
  try {
    const first = new History(c);
    for (let i = 0; i < 130; i++) {
      const s = emptySnapshot(now + i * 1000);
      s.lanes = [laneSnapshot({ cpu: i })];
      first.add(s);
    }
    first.close();
    // Reopened, the archive is empty, so every row is read back from SQLite.
    const reopened = new History(c);
    try {
      const spy = spyOn(Bun, "gunzipSync");
      const decompressed: number[] = [];
      let back: LaneSample[] | undefined;
      try {
        // The list reads on its quantised end, the detail on the sample time
        // past the next bucket boundary, and the list again on that boundary.
        // The last starts two rows before what the detail left held.
        for (const at of [100000, 107000, 105000]) {
          back = (await reopened.laneWindows([id], now + at, windowMs)).get(id);
          decompressed.push(spy.mock.calls.length);
        }
      } finally {
        spy.mockRestore();
      }
      // Sixty-one rows for the first window, then only the rows each later
      // read reaches outside what is held: seven after it, two before it.
      expect(decompressed).toEqual([61, 68, 70]);
      expect(back?.map((x) => x.cpu)).toEqual(
        Array.from({ length: 61 }, (_, i) => 45 + i),
      );
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
  // A margin, for the reason the first case gives.
}, 30000);
