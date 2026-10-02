import { expect, spyOn, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, fixture, laneSnapshot } from "../test/fixture";
import { present } from "../test/present";
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
    expect(series[301]?.cpu).toBe(99);
    expect(series[302]?.memoryPressure).toBe(50);
    expect(series[303]?.ioPressure).toBe(25);
    expect(series[400]?.rss).toBeNull();
    present(series[0], "the first sample").cpu = 700;
    const next = emptySnapshot(602000);
    next.lanes = [laneSnapshot({ cpu: 20 })];
    h.add(next);
    expect((await read(602000, 86400000))[0]?.cpu).toBe(0);
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
      expect(a?.[65]?.cpu).toBe(99);
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
  const kept = present(ids[0], "the first lane");
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
      next.lanes = [laneSnapshot({ id: kept, cpu: 0 })];
      reopened.add(next);
      expect([...(stored()?.lanes.keys() ?? [])]).toEqual([kept]);
      // Once the window starts after the last stored row it reads only the
      // archive, and the stored series go.
      for (let i = 2; i <= 12; i++) {
        const s = emptySnapshot(end + i * 1000);
        s.lanes = [laneSnapshot({ id: kept, cpu: 0 })];
        reopened.add(s);
      }
      await reopened.laneWindows([kept], end + 12000, 10000);
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
    for (let i = 0; i < 140; i++) {
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
      const reads: ((number | null)[] | undefined)[] = [];
      try {
        // The list reads on its quantised end and the detail on the sample
        // time, up to one trend bucket later. A visit to the detail, a return
        // to the list, then a longer visit that lets the oldest rows go, a
        // return to the list a bucket behind it, and that list read repeated.
        for (const at of [100000, 107000, 105000, 134000, 130000, 130000]) {
          const series = await reopened.laneWindows([id], now + at, windowMs);
          reads.push(series.get(id)?.map((x) => x.cpu));
          decompressed.push(spy.mock.calls.length);
        }
      } finally {
        spy.mockRestore();
      }
      // Sixty-one rows for the first window, then only the rows each read
      // reaches outside what is held: seven after it; none for the list a
      // bucket behind; twenty-seven after it, where the rows before the window
      // now outnumber those inside it and are let go; four before it for the
      // list behind that; and none for the same read again.
      expect(decompressed).toEqual([61, 68, 68, 95, 99, 99]);
      const run = (from: number) =>
        Array.from({ length: 61 }, (_, i) => from + i);
      expect(reads).toEqual([
        run(40),
        run(47),
        run(45),
        run(74),
        run(70),
        run(70),
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
  // A margin, for the reason the first case gives.
}, 30000);
