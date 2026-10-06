import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { volumeSnapshot } from "../test/fixture";
import { Reader } from "./io";
import { escapePath, missingScrubTimers, scrubTimer } from "./scrub-timers";

test("a mount is escaped as systemd-escape --path writes it", () => {
  expect(
    ["/", "/home", "/mnt/data/", "/mnt/a-b", "/.snap", "/mnt/x y"].map(
      escapePath,
    ),
  ).toEqual([
    "-",
    "home",
    "mnt-data",
    "mnt-a\\x2db",
    "\\x2esnap",
    "mnt-x\\x20y",
  ]);
});

/** A scratch systemd tree: the packaged drop-in and the enabled timers. */
function units(o: { dropIn: boolean; enabled?: string[] | "unreadable" }) {
  const root = mkdtempSync(join(tmpdir(), "vsys-scrub-timers-"));
  const dropIn = join(root, "vsys-report.conf");
  const wants = join(root, "timers.target.wants");
  if (o.dropIn) writeFileSync(dropIn, "[Service]\n");
  // A file where the directory should be is a listing that fails.
  if (o.enabled === "unreadable") writeFileSync(wants, "");
  else if (o.enabled) {
    mkdirSync(wants);
    for (const unit of o.enabled) writeFileSync(join(wants, unit), "");
  }
  return { root, units: { dropIn, wants } };
}

const volumes = [
  volumeSnapshot("/", { fsid: "a" }),
  volumeSnapshot("/home", { fsid: "a" }),
  volumeSnapshot("/mnt/data", { fsid: "b" }),
];

test("each filesystem with no enabled timer on any mount needs one", async () => {
  for (const [name, enabled, missing] of [
    ["no timer enabled", undefined, [scrubTimer("/"), scrubTimer("/mnt/data")]],
    [
      "one mount of a filesystem",
      [scrubTimer("/home")],
      [scrubTimer("/mnt/data")],
    ],
    ["every filesystem", [scrubTimer("/"), scrubTimer("/mnt/data")], []],
  ] as const) {
    const t = units({ dropIn: true, enabled: enabled && [...enabled] });
    const r = new Reader();
    expect({
      name,
      missing: await missingScrubTimers(r, t.units, volumes),
      errors: r.errors.length,
    }).toEqual({ name, missing: [...missing], errors: 0 });
    rmSync(t.root, { recursive: true });
  }
});

test("no packaged drop-in is no packaged reporter, whatever is enabled", async () => {
  const t = units({ dropIn: false, enabled: [] });
  expect(await missingScrubTimers(new Reader(), t.units, volumes)).toBe(
    undefined,
  );
  rmSync(t.root, { recursive: true });
});

test("timers that cannot be listed stay unknown rather than none", async () => {
  const t = units({ dropIn: true, enabled: "unreadable" });
  const r = new Reader();
  expect(await missingScrubTimers(r, t.units, volumes)).toBe(null);
  expect(r.errors.map((e) => e.source)).toEqual([t.units.wants]);
  rmSync(t.root, { recursive: true });
});
