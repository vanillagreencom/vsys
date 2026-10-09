import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "../config/config";
import { causes, unjudged } from "../model/verdict";
import { EventLog, type TimelineEvent } from "../store/events";
import { emptySnapshot, fixture, serviceSnapshot } from "../test/fixture";
import { attention } from "../ui/attention";
import { Collector, createCollector } from "./collector";
import { Reader } from "./io";
import { ServiceCpu } from "./services";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
const minute = 60_000;
const unit = "system.slice/bpftune.service";

/**
 * A host whose system.slice holds `paths`, one unit unless given, their CPU
 * counters driven at a share of one core per stretch of minutes, sampled every
 * ten seconds through the checkpoints, the ladder, the cards and the event log.
 */
function host(o: { paths?: string[]; serviceCpuPercent?: number } = {}) {
  const f = fixture();
  fixtures.push(f);
  const c = defaults();
  c.serviceCpuPercent = o.serviceCpuPercent ?? c.serviceCpuPercent;
  const top = f.config.cgroupTop;
  const services = new ServiceCpu();
  const log = new EventLog();
  const events: TimelineEvent[] = [];
  let now = 0;
  let usec = 0;
  const stat = () => {
    for (const path of o.paths ?? [unit])
      f.write(join(top, path, "cpu.stat"), `usage_usec ${usec}\n`);
  };
  stat();
  const sample = () => {
    const s = emptySnapshot(now + 1000);
    const r = new Reader();
    s.services = services.read(r, top, now);
    s.errors = r.errors;
    events.push(...log.advance(s, c));
    return s;
  };
  /**
   * `percent` of a core for `minutes`, or no counter write at all, sampled
   * every `stepMs`.
   */
  const run = (percent: number | null, minutes: number, stepMs = 10_000) => {
    let s = sample();
    for (let step = 0; step < (minutes * minute) / stepMs; step++) {
      now += stepMs;
      if (percent !== null) {
        usec += percent * stepMs * 10;
        stat();
      }
      s = sample();
    }
    return s;
  };
  const card = (s: ReturnType<typeof sample>) =>
    attention(s, c, { basePath: [] }).find((a) => a.id === "service-cpu");
  const opened = () =>
    events.filter((e) => e.cause === "service-cpu" && e.kind === "alert-open");
  const closed = () =>
    events.filter((e) => e.cause === "service-cpu" && e.kind === "alert-close");
  return { f, c, top, run, card, opened, closed };
}

test("a unit at half a core for an hour raises its card and one alert; at 5% none", () => {
  for (const [percent, raised] of [
    [50, true],
    [5, false],
  ] as const) {
    const h = host();
    // Short of an hour there is no hour average, so nothing is judged.
    let s = h.run(percent, 59);
    expect(s.services?.[0]?.cpuHourPercent).toBeNull();
    expect(h.card(s)).toBeUndefined();
    s = h.run(percent, 3);
    expect(s.services?.[0]?.cpuHourPercent).toBeCloseTo(percent, 5);
    const card = h.card(s);
    if (!raised) {
      expect(card).toBeUndefined();
      expect(h.opened()).toEqual([]);
      continue;
    }
    expect(card?.title).toContain("bpftune");
    expect(card?.next).toContain("sudo systemctl restart bpftune.service");
    expect(h.opened()).toHaveLength(1);
    expect(h.opened()[0]).toMatchObject({
      subjectId: unit,
      names: { unit: "bpftune.service" },
      values: { threshold: h.c.serviceCpuPercent },
    });
    expect(h.opened()[0]?.values.hour).toBeCloseTo(percent, 5);
  }
});

test("at a threshold of zero a unit with no hour yet raises nothing", () => {
  const h = host({ serviceCpuPercent: 0 });
  const s = h.run(5, 59);
  expect(s.services?.[0]?.cpuHourPercent).toBeNull();
  expect(h.card(s)).toBeUndefined();
  expect(h.opened()).toEqual([]);
});

test("a refresh interval longer than the window gives no hour average", () => {
  // Samples two hours apart, as the longest refresh interval takes them: half
  // a core across two hours can be one busy hour and one idle hour.
  const sparse = host();
  const s = sparse.run(50, 360, 120 * minute);
  expect(s.services?.[0]?.cpuHourPercent).toBeNull();
  expect(sparse.card(s)).toBeUndefined();
});

test("a gap in sampling gives no hour average until an hour follows it", () => {
  const gap = host();
  gap.run(0, 5);
  const after = gap.run(50, 120, 120 * minute);
  expect(after.services?.[0]?.cpuHourPercent).toBeNull();
  expect(gap.card(after)).toBeUndefined();
  const recovered = gap.run(0, 61);
  expect(recovered.services?.[0]?.cpuHourPercent).toBe(0);
});

test("a busy scope or mount under system.slice raises nothing", () => {
  // A container under Docker's systemd cgroup driver, a FUSE daemon in its
  // mount unit, and a transient scope inside a nested slice.
  const h = host({
    paths: [
      "system.slice/docker-0123abcd.scope",
      "system.slice/data.mount",
      "system.slice/system-run.slice/run-1.scope",
    ],
  });
  const s = h.run(50, 62);
  expect(s.services).toEqual([]);
  expect(h.card(s)).toBeUndefined();
  expect(h.opened()).toEqual([]);
});

test("a unit that drops below clears its card, and a second rise is a second alert", () => {
  const h = host();
  h.run(50, 62);
  expect(h.opened()).toHaveLength(1);
  // The hour average falls under 25% once 30 idle minutes fill the window.
  const idle = h.run(0, 40);
  expect(h.card(idle)).toBeUndefined();
  expect(h.closed()).toHaveLength(1);
  const busy = h.run(100, 15);
  expect(h.card(busy)).toBeDefined();
  expect(h.opened()).toHaveLength(2);
});

test("a restarted unit or a counter that went back starts a new hour", () => {
  const restart = (h: ReturnType<typeof host>) => {
    // Both directories exist at once, so the new cgroup cannot reuse the
    // inode of the one it replaces. Its counter is above the old one, so only
    // the new identity can start the new hour.
    h.f.write(
      join(h.top, `${unit}.new`, "cpu.stat"),
      "usage_usec 9000000000\n",
    );
    rmSync(join(h.top, unit), { recursive: true });
    renameSync(join(h.top, `${unit}.new`), join(h.top, unit));
  };
  const backwards = (h: ReturnType<typeof host>) =>
    h.f.write(join(h.top, unit, "cpu.stat"), "usage_usec 0\n");
  for (const reset of [restart, backwards]) {
    const h = host();
    expect(h.card(h.run(50, 62))).toBeDefined();
    reset(h);
    // The next checkpoint is a minute on, and it reads the new counter.
    const s = h.run(null, 1);
    expect(s.services?.[0]?.read).toBe(true);
    expect(s.services?.[0]?.cpuHourPercent).toBeNull();
    expect(h.card(s)).toBeUndefined();
    // A unit with no hour is absent, not unread, so its alert closes.
    h.run(null, 1);
    expect(h.closed()).toHaveLength(1);
  }
});

test("each unit's alert records its own hour, not the busiest unit's", () => {
  const c = defaults();
  const log = new EventLog();
  const events: TimelineEvent[] = [];
  const hours = { "system.slice/a.service": 30, "system.slice/b.service": 80 };
  for (let time = 0; time <= c.pressureHoldSeconds * 1000; time += 1000) {
    const s = emptySnapshot(time + 1000);
    s.services = Object.entries(hours).map(([path, cpuHourPercent]) =>
      serviceSnapshot({ path, name: path.split("/")[1], cpuHourPercent }),
    );
    events.push(...log.advance(s, c));
  }
  const opened = events.filter((e) => e.kind === "alert-open");
  expect(
    Object.fromEntries(opened.map((e) => [e.subjectId, e.values.hour])),
  ).toEqual(hours);
});

test("only units under system.slice and one slice inside it are subjects", () => {
  const f = fixture();
  fixtures.push(f);
  const top = f.config.cgroupTop;
  for (const path of [
    unit,
    // A unit's own children are already in its counter.
    `${unit}/worker`,
    "system.slice/system-getty.slice/getty@tty1.service",
    "system.slice/system-getty.slice/deeper.slice/hidden.service",
  ])
    f.write(join(top, path, "cpu.stat"), "usage_usec 1\n");
  const services = new ServiceCpu().read(new Reader(), top, 0);
  expect(services?.map((u) => u.path).sort()).toEqual([
    unit,
    "system.slice/system-getty.slice/getty@tty1.service",
  ]);
});

test("an unread unit or slice keeps its open alert open and is never a zero", () => {
  const unreadable = (h: ReturnType<typeof host>) => {
    chmodSync(join(h.top, unit, "cpu.stat"), 0);
    return [unit];
  };
  const unlisted = (h: ReturnType<typeof host>) => {
    chmodSync(join(h.top, "system.slice"), 0);
    return "all" as const;
  };
  for (const hide of [unreadable, unlisted]) {
    const h = host();
    h.run(50, 62);
    expect(h.opened()).toHaveLength(1);
    const expected = hide(h);
    try {
      // Twenty minutes is far past the hold an absent unit closes after.
      const s = h.run(null, 20);
      expect(h.closed()).toEqual([]);
      expect(s.services?.[0]?.read ?? false).toBe(false);
      expect(s.services?.[0]?.cpuHourPercent ?? null).toBeNull();
      const held = unjudged(s, h.c)["service-cpu"];
      expect(held === "all" ? held : [...(held ?? [])]).toEqual(expected);
      expect(causes(s, h.c).some((x) => x.id === "service-cpu")).toBe(false);
    } finally {
      chmodSync(join(h.top, "system.slice"), 0o755);
      chmodSync(join(h.top, unit, "cpu.stat"), 0o644);
    }
  }
});

test("a settings change keeps each unit's hour", async () => {
  const f = fixture();
  fixtures.push(f);
  const top = f.config.cgroupTop;
  const at = async (collector: Collector, time: number) => {
    const now = spyOn(performance, "now").mockReturnValue(time);
    return collector.sample(time).finally(() => now.mockRestore());
  };
  f.write(join(top, unit, "cpu.stat"), "usage_usec 0\n");
  const before = new Collector(f.config, 100, 4096);
  expect((await at(before, 0)).services?.[0]?.cpuHourPercent).toBeNull();
  // Half a core for the hour, read by the collector a settings change built.
  f.write(
    join(top, unit, "cpu.stat"),
    `usage_usec ${0.5 * 60 * minute * 1000}\n`,
  );
  const after = await createCollector(
    f.config,
    false,
    before,
    f.agentToolsPath,
  );
  try {
    const s = await at(after, 60 * minute);
    expect(s.services?.[0]?.cpuHourPercent).toBeCloseTo(50, 5);
  } finally {
    before.close();
    after.close();
  }
});

test("a settings change that moves the cgroup root reads the new root at once", async () => {
  const f = fixture();
  fixtures.push(f);
  const at = async (collector: Collector, time: number) => {
    const now = spyOn(performance, "now").mockReturnValue(time);
    return collector.sample(time).finally(() => now.mockRestore());
  };
  f.write(join(f.config.cgroupTop, unit, "cpu.stat"), "usage_usec 0\n");
  const before = new Collector(f.config, 100, 4096);
  await at(before, 0);
  const moved = { ...f.config, cgroupTop: join(f.root, "other-root") };
  const other = "system.slice/other.service";
  f.write(join(moved.cgroupTop, other, "cpu.stat"), "usage_usec 0\n");
  const after = await createCollector(moved, false, before, f.agentToolsPath);
  try {
    // A second on, well inside the minute the old root's reading covers.
    const s = await at(after, 1000);
    expect(s.services?.map((u) => u.path)).toEqual([other]);
  } finally {
    before.close();
    after.close();
  }
});
