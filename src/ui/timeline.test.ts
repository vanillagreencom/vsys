import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { TimelineEvent } from "../store/events";
import { causePhrase, eventKey, eventLine } from "./timeline";

const c = defaults();
const event = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  time: 1000,
  kind: "verdict",
  subject: "",
  subjectId: "",
  cause: "",
  names: {},
  values: {},
  ...o,
});
test("every event is one line that states its cause", () => {
  const lines = [
    eventLine(
      event({
        kind: "lane-start",
        subject: "lane-a",
        names: { account: "work", slice: "agents.slice", tool: "claude" },
      }),
      c,
    ),
    eventLine(
      event({
        kind: "lane-stop",
        subject: "lane-a",
        names: { account: "work", slice: "agents.slice" },
        values: { age: 120 },
      }),
      c,
    ),
    eventLine(
      event({
        kind: "cgroup-move",
        subject: "claude PID 40",
        cause: "unconfined",
        names: { from: "agents.slice", to: "app.slice" },
      }),
      c,
    ),
    eventLine(
      event({
        kind: "alert-close",
        cause: "disk",
        values: { durationMs: 90000 },
      }),
      c,
    ),
    eventLine(
      event({ kind: "verdict", cause: "stalls", names: { previous: "" } }),
      c,
    ),
  ];
  for (const line of lines) expect(line).not.toContain("\n");
  expect(lines[0]).toContain("account work in agents.slice");
  expect(
    eventLine(event({ kind: "lane-start", names: { slice: "app.slice" } }), c),
  ).toContain("account not available in app.slice");
  expect(lines[1]).toContain("2m");
  expect(lines[2]).toContain("an agent ran outside the agent slice");
  expect(lines[3]).toContain("Alert closed: storage stalled tasks");
  expect(lines[3]).toContain("open for 1m");
  expect(causePhrase("scrub")).toBe("a scrub reported a problem");
  expect(lines[4]).toContain("previously nothing needs attention");
});
test("a swap crossing states the swap and the floor it passed", () => {
  const line = eventLine(
    event({
      kind: "alert-open",
      subject: "gnome.scope",
      cause: "desktop-swap",
      values: { swap: c.swapFloor * 2, floor: c.swapFloor },
    }),
    c,
  );
  expect(line).toContain("Alert opened: the desktop swapped out");
  expect(line).toContain("1.0 GiB swapped against a floor of 512.0 MiB");
  // The floor the event recorded, never the one the reader holds now.
  const later = { ...c, swapFloor: c.swapFloor * 4 };
  expect(
    eventLine(
      event({
        kind: "alert-open",
        cause: "desktop-swap",
        values: { swap: c.swapFloor * 2, floor: c.swapFloor },
      }),
      later,
    ),
  ).toContain("floor of 512.0 MiB");
  // An older row that recorded no floor says so rather than borrowing one.
  expect(
    eventLine(
      event({ kind: "alert-open", cause: "desktop-swap", values: {} }),
      c,
    ),
  ).toContain("floor of not available");
});
test("a move inside one slice names the cgroups, not a slice change", () => {
  const inside = eventLine(
    event({
      kind: "cgroup-move",
      subject: "claude PID 40",
      names: {
        from: "agents.slice/a.scope",
        to: "agents.slice/b.scope",
        fromSlice: "agents.slice",
        toSlice: "agents.slice",
      },
    }),
    c,
  );
  expect(inside).toContain("agents.slice/a.scope to agents.slice/b.scope");
  expect(inside).toContain("it stayed in agents.slice");
  const across = eventLine(
    event({
      kind: "cgroup-move",
      subject: "claude PID 40",
      names: {
        from: "agents.slice/a.scope",
        to: "app.slice/a.scope",
        fromSlice: "agents.slice",
        toSlice: "app.slice",
      },
    }),
    c,
  );
  expect(across).toContain("it left agents.slice for app.slice");
});
test("a verdict that only escalates says so instead of repeating itself", () => {
  const raised = eventLine(
    event({
      kind: "verdict",
      subject: "busy",
      cause: "stalls",
      names: { previous: "stalls", previousLevel: "warn", level: "danger" },
    }),
    c,
  );
  expect(raised).toContain("now serious, was a warning");
  expect(raised).not.toContain("previously");
  const replaced = eventLine(
    event({
      kind: "verdict",
      cause: "stalls",
      names: { previous: "disk", previousLevel: "danger", level: "warn" },
    }),
    c,
  );
  expect(replaced).toContain(`previously ${causePhrase("disk")}`);
});
test("a scratch line states the size of its own path", () => {
  expect(
    eventLine(
      event({
        kind: "alert-open",
        subject: "/small",
        cause: "scratch",
        values: { bytes: 1024, quota: 512, largest: 999999 },
      }),
      c,
    ),
  ).toContain("1.0 KiB against a quota of 512 B");
});

test("an event's identity tells two alerts apart that share a subject", () => {
  const base = {
    time: 1000,
    subject: "gnome",
    subjectId: "app.slice/gnome.scope",
    names: {},
    values: {},
  };
  // One sample can open two alerts for one subject under different causes.
  // Without the cause in the identity they are one key, and React is free to
  // reuse or drop the wrong row.
  const swap = eventKey({
    ...base,
    kind: "alert-open",
    cause: "desktop-swap",
  } as TimelineEvent);
  const memory = eventKey({
    ...base,
    kind: "alert-open",
    cause: "system-memory",
  } as TimelineEvent);
  expect(swap).not.toBe(memory);
  // And every field that can differ does differ the key.
  const parts = [
    { time: 2000 },
    { kind: "alert-close" },
    { cause: "disk" },
    { subjectId: "other.scope" },
  ];
  for (const part of parts) {
    const other = eventKey({
      ...base,
      kind: "alert-open",
      cause: "desktop-swap",
      ...part,
    } as TimelineEvent);
    expect({ part, same: other === swap }).toEqual({ part, same: false });
  }
});
