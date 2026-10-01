import { expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import {
  type PaceClock,
  restMs,
  type ScanRoot,
  scanScratch,
} from "./scratch-scan";

const full = { sliceMs: 10, dutyPercent: 100 };

test("one traversal counts hard links once per root and once per session", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    f.write(join(path, "a/file"), "1234");
    f.write(join(path, "b/empty"), "");
    linkSync(join(path, "a/file"), join(path, "b/shared"));
    symlinkSync(f.root, join(path, "loop"));
    const missing = join(f.root, "missing");
    const { scan: result } = await scanScratch(
      [
        { path, origin: "configured" },
        { path: missing, origin: "configured" },
      ],
      Date.now(),
      full,
    );
    expect(result.scratch[0].bytes).toBe(
      lstatSync(path).size +
        lstatSync(join(path, "a")).size +
        lstatSync(join(path, "b")).size +
        4,
    );
    expect(result.sessions.find((s) => s.path === join(path, "a"))?.bytes).toBe(
      lstatSync(join(path, "a")).size + 4,
    );
    expect(result.sessions.find((s) => s.path === join(path, "b"))?.bytes).toBe(
      lstatSync(join(path, "b")).size + 4,
    );
    // A root that could not be read reports no size at all, and its own
    // failure, rather than a zero beside the roots that were read.
    expect(result.scratch[1].bytes).toBeNull();
    expect(result.errors.map((e) => e.source)).toEqual([missing]);
    expect(result.scratch[0].error).toBeNull();
  } finally {
    f.cleanup();
  }
});

test("only a root on a list other than the shipped one fails for not existing", async () => {
  const f = fixture();
  try {
    const present = join(f.root, "present");
    const file = join(f.root, "file");
    f.write(join(present, "session/file"), "1234");
    f.write(file, "");
    const at = (name: string) => join(f.root, name);
    const me = lstatSync(present).uid;
    const nested = join(f.root, "nested");
    f.write(join(nested, "locked/file"), "1234");
    chmodSync(join(nested, "locked"), 0o000);
    // Each row is one root scanned alone: whether it has a row, the error on
    // that row, whether it counts as a missing default, and the source error.
    const rows: [
      ScanRoot,
      { row: boolean; error: boolean; absent: boolean },
    ][] = [
      // The shipped list on a machine that has none of it: no row, no
      // error, and the screen can say the defaults are not here.
      [
        { path: at("default-a"), origin: "default" },
        { row: false, error: false, absent: true },
      ],
      // An agent's temporary directory it never created was asked for by
      // nobody, so it leaves no trace at all.
      [
        { path: at("agent-gone"), origin: "agent", owner: me },
        { row: false, error: false, absent: false },
      ],
      // A root the reader typed that is missing is a real problem.
      [
        { path: at("typed-gone"), origin: "configured" },
        { row: true, error: true, absent: false },
      ],
      // A default that exists is measured as it always was.
      [
        { path: present, origin: "default" },
        { row: true, error: false, absent: false },
      ],
      [
        { path: present, origin: "agent", owner: me },
        { row: true, error: false, absent: false },
      ],
      // A directory another user owns is shared, as the system's /tmp is,
      // and not the agent's own: no row, no error, and not a missing default.
      [
        { path: present, origin: "agent", owner: me + 1 },
        { row: false, error: false, absent: false },
      ],
      // A directory deeper in the walk that cannot be read fails the root
      // whatever its origin; only the root's own lookup can find it absent.
      // No fixture removes a directory between its status read and its
      // listing, so the vanished case is held by that lookup alone.
      [
        { path: nested, origin: "default" },
        { row: true, error: true, absent: false },
      ],
      [
        { path: nested, origin: "agent", owner: me },
        { row: true, error: true, absent: false },
      ],
      // A default that exists and cannot be measured still fails: only
      // nonexistence means the default is not configured here.
      [
        { path: file, origin: "default" },
        { row: true, error: true, absent: false },
      ],
    ];
    for (const [root, expected] of rows) {
      const { scan } = await scanScratch([root], 1000, full);
      expect({ root, ...expected }).toEqual({
        root,
        row: scan.scratch.length === 1,
        error: scan.errors.length === 1 && scan.scratch[0]?.error !== null,
        absent: scan.absent.includes(root.path),
      });
      // A row says where it came from.
      expect(scan.scratch.map((x) => x.origin)).toEqual(
        expected.row ? [root.origin] : [],
      );
    }
  } finally {
    chmodSync(join(f.root, "nested/locked"), 0o700);
    f.cleanup();
  }
});

test("a traversal rests for what each spent slice earned", async () => {
  const f = fixture();
  const path = join(f.root, "scratch");
  try {
    for (let i = 0; i < 4; i++) f.write(join(path, `dir-${i}/file`), "1234");
    const roots: ScanRoot[] = [{ path, origin: "configured" }];
    // The clock advances a fixed step per reading, so every entry measures
    // the same busy time however loaded the machine running this is. A slice
    // of zero makes every entry end one.
    const step = 5;
    const busy = step * 2;
    // At a duty of 100 a slice earns nothing, and the traversal takes no
    // timer turn for it.
    const rows: [number, number[]][] = [
      [100, []],
      [50, [busy]],
      [25, [busy * 3]],
      [20, [busy * 4]],
    ];
    for (const [dutyPercent, expected] of rows) {
      let reading = 0;
      const sleeps: number[] = [];
      const clock: PaceClock = {
        now: () => {
          reading += step;
          return reading;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      };
      const { scan, rests } = await scanScratch(
        roots,
        Date.now(),
        { sliceMs: 0, dutyPercent },
        clock,
      );
      expect({ dutyPercent, error: scan.scratch[0].error }).toEqual({
        dutyPercent,
        error: null,
      });
      // Every entry under 100 rests, so a traversal that skips the rest there
      // records none at all, and the count it reports is the rests it took.
      expect({ dutyPercent, waited: [...new Set(sleeps)], rests }).toEqual({
        dutyPercent,
        waited: expected,
        rests: sleeps.length,
      });
    }
  } finally {
    f.cleanup();
  }
});

test("the rest a slice earns holds the traversal to its share of a thread", () => {
  // busy / (busy + rest) is the share the traversal keeps.
  const rows: [number, number, number][] = [
    [10, 100, 0],
    [10, 50, 10],
    [10, 25, 30],
    [10, 20, 40],
    [8, 1, 792],
  ];
  for (const [busy, duty, rest] of rows)
    expect({ busy, duty, rest: restMs(busy, duty) }).toEqual({
      busy,
      duty,
      rest,
    });
  expect(restMs(0, 25)).toBe(0);
});
