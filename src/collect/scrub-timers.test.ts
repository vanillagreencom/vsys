import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reader } from "./io";
import {
  escapePath,
  missingScrubTimers,
  type ScrubUnits,
  scrubTimer,
} from "./scrub-timers";

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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
/**
 * The packaged drop-in in a scratch directory, and a stub for systemd's
 * answer: each unit's `is-enabled` word, `disabled` where none is named, so
 * no test asks the real systemd.
 */
function units(
  o: {
    dropIn?: boolean;
    words?: Record<string, string>;
    answer?: "none" | "throws";
  } = {},
): ScrubUnits & { asked: string[][] } {
  const root = mkdtempSync(join(tmpdir(), "vsys-scrub-timers-"));
  roots.push(root);
  const dropIn = join(root, "vsys-report.conf");
  if (o.dropIn ?? true) writeFileSync(dropIn, "[Service]\n");
  const asked: string[][] = [];
  return {
    dropIn,
    asked,
    states: async (names) => {
      asked.push(names);
      if (o.answer === "throws") throw new Error("spawn systemctl ENOENT");
      if (o.answer === "none") return null;
      return names.map((name) => o.words?.[name] ?? "disabled");
    },
  };
}

const volumes = [
  { mount: "/", device: "/dev/a", fsid: "a", watched: true },
  { mount: "/home", device: "/dev/a", fsid: "a", watched: true },
  { mount: "/mnt/data", device: "/dev/b", fsid: "b", watched: true },
];

test("each filesystem whose timers systemd calls disabled needs one", async () => {
  for (const [name, words, missing] of [
    ["none enabled", {}, [scrubTimer("/"), scrubTimer("/mnt/data")]],
    [
      "one mount of a filesystem",
      { [scrubTimer("/home")]: "enabled" },
      [scrubTimer("/mnt/data")],
    ],
    [
      "every filesystem",
      { [scrubTimer("/")]: "enabled", [scrubTimer("/mnt/data")]: "enabled" },
      [],
    ],
  ] as const) {
    const r = new Reader();
    expect({
      name,
      missing: await missingScrubTimers(r, units({ words }), volumes),
      errors: r.errors.length,
    }).toEqual({ name, missing: [...missing], errors: 0 });
  }
});

test("a timer enabled for this boot only still schedules its filesystem", async () => {
  const words = { [scrubTimer("/")]: "enabled-runtime" };
  expect(
    await missingScrubTimers(new Reader(), units({ words }), volumes),
  ).toEqual([scrubTimer("/mnt/data")]);
});

test("a masked or missing template offers nothing, since systemctl would refuse to enable it", async () => {
  for (const word of ["masked", "masked-runtime", "not-found"]) {
    const words = Object.fromEntries(
      volumes.map((v) => [scrubTimer(v.mount), word]),
    );
    expect({
      word,
      missing: await missingScrubTimers(
        new Reader(),
        units({ words }),
        volumes,
      ),
    }).toEqual({ word, missing: [] });
  }
});

test("no packaged drop-in is no packaged reporter, and systemd is not asked", async () => {
  const systemd = units({ dropIn: false });
  expect(await missingScrubTimers(new Reader(), systemd, volumes)).toBe(
    undefined,
  );
  expect(systemd.asked).toEqual([]);
});

test("timers systemd did not answer for stay unknown rather than none", async () => {
  for (const answer of ["none", "throws"] as const) {
    const r = new Reader();
    expect({
      answer,
      missing: await missingScrubTimers(r, units({ answer }), volumes),
      errors: r.errors.map((e) => e.source),
    }).toEqual({
      answer,
      missing: null,
      errors: answer === "throws" ? ["systemctl"] : [],
    });
  }
});

test("a timer on an unwatched mount covers the filesystem a watched mount shares", async () => {
  const mounts = [
    { mount: "/", device: "/dev/a", fsid: "a", watched: false },
    { mount: "/home", device: "/dev/a", fsid: "a", watched: true },
    { mount: "/mnt/data", device: "/dev/b", fsid: "b", watched: false },
  ];
  for (const [words, missing] of [
    [{ [scrubTimer("/")]: "enabled" }, []],
    // Unchecked, the watched filesystem is named for its watched mount, and
    // a filesystem vsys does not watch is offered nothing.
    [{}, [scrubTimer("/home")]],
  ] as const) {
    expect(
      await missingScrubTimers(new Reader(), units({ words }), mounts),
    ).toEqual([...missing]);
  }
});

test("mounts whose filesystem id is unread are one filesystem by their device, as Storage groups them", async () => {
  const mounts = [
    { mount: "/", device: "/dev/a", fsid: null, watched: true },
    { mount: "/home", device: "/dev/a", fsid: null, watched: true },
  ];
  expect(await missingScrubTimers(new Reader(), units(), mounts)).toEqual([
    scrubTimer("/"),
  ]);
});
