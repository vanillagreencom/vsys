import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import type { TimelineEvent } from "../store/events";
import { causePhrase, eventLine } from "./timeline";

const c = defaults();
const event = (o: Partial<TimelineEvent> = {}): TimelineEvent => ({
  time: 1000,
  kind: "verdict",
  subject: "",
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
      values: { swap: c.swapFloor * 2 },
    }),
    c,
  );
  expect(line).toContain("Alert opened: the desktop swapped out");
  expect(line).toContain("1.0 GiB swapped against a floor of 512.0 MiB");
});
