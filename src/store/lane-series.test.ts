import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { emptySnapshot, fixture, laneSnapshot } from "../test/fixture";
import { History } from "./history";

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
    const series = await h.laneWindow(id, 601000, 86400000);
    expect(series).toHaveLength(601);
    expect(series[301].cpu).toBe(99);
    expect(series[302].memoryPressure).toBe(50);
    expect(series[303].ioPressure).toBe(25);
    expect(series[400].rss).toBeNull();
    series[0].cpu = 700;
    const next = emptySnapshot(602000);
    next.lanes = [laneSnapshot({ cpu: 20 })];
    h.add(next);
    expect((await h.laneWindow(id, 602000, 86400000))[0].cpu).toBe(0);
    expect((await h.laneWindow(id, 602000, 1000)).at(-1)?.cpu).toBe(20);
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
        reopened.laneWindow(id, now + 129000, 86400000),
        reopened.laneWindow(id, now + 129000, 86400000),
      ]);
      expect(a).toHaveLength(130);
      expect(b).toHaveLength(130);
      expect(a[65].cpu).toBe(99);
      expect(b).toEqual(a);
    } finally {
      reopened.close();
    }
  } finally {
    f.cleanup();
  }
});
