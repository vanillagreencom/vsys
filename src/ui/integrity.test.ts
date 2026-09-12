import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { integrity, volumesByDevice } from "../model/integrity";
import type { Scrub } from "../model/types";
import { volumeSnapshot } from "../test/fixture";
import {
  damageAdvice,
  deleteCommand,
  integrityLine,
  integrityWords,
  noDamageText,
  rebuildCommand,
} from "./integrity";

const day = 86400000;
const now = 1_760_000_000_000;
const c = defaults();
function state(scrubs: Scrub[], lastErrorAt: number | null = null) {
  return integrity(
    volumesByDevice([
      volumeSnapshot("/", {
        fsid: "fs",
        errors: { "1/corruption_errs": 1390 },
        countersAvailable: true,
        lastErrorAt,
        lastErrorSize: lastErrorAt === null ? null : 26,
      }),
    ])[0],
    scrubs,
    now,
    c,
  );
}
function report(overrides: Partial<Scrub> = {}): Scrub {
  return {
    path: "/run/btrfs-scrub/root.result",
    text: "Error summary: no errors found",
    problem: false,
    readable: true,
    fsid: "fs",
    startedAt: now - day,
    status: "finished",
    uncorrectable: 0,
    addresses: [],
    ...overrides,
  };
}

test("the line answers both questions without opening anything", () => {
  // The case that started this: a counter flat for 31 hours, a check four days
  // old. A flat counter is not a healthy disk, and the line says so.
  const line = integrityLine(
    state([report({ startedAt: now - 4 * day })], now - 31 * 3600000),
  );
  expect(line).toBe(
    "New errors since last check · last full check 4.0d ago · last new error 31.0h ago",
  );
  // Nothing checked, nothing recorded: both times say so rather than reading
  // as zero or as healthy.
  expect(integrityLine(state([]))).toBe(
    "Never checked · last full check never · last new error none recorded",
  );
});

test("no words but Healthy say the filesystem was checked and found sound", () => {
  expect(integrityWords(state([report()], null))).toBe("Healthy");
  expect(integrityWords(state([]))).toBe("Never checked");
  expect(integrityWords(state([report({ startedAt: now - 40 * day })]))).toBe(
    "Not checked in 40.0d",
  );
  expect(integrityWords(state([report({ status: "running" })]))).toBe(
    "Checking now",
  );
  expect(
    integrityWords(state([report({ readable: false, problem: true })])),
  ).toBe("Damage state unknown");
});

test("the damaged-file headline counts files and says when a rebuild fixes it", () => {
  const build = state([
    report({
      problem: true,
      uncorrectable: 26,
      addresses: [
        { logical: 1, paths: ["/r/target/a", "/r/target/b"] },
        { logical: 2, paths: ["/r/target/c"] },
      ],
    }),
  ]);
  expect(integrityWords(build)).toBe(
    "Damaged files found: 3 files, all build output",
  );
  // One file outside build output and the claim is withdrawn, because a
  // rebuild does not replace it.
  const mixed = state([
    report({
      problem: true,
      uncorrectable: 26,
      addresses: [
        { logical: 1, paths: ["/r/target/a"] },
        { logical: 2, paths: ["/home/r/letter.txt"] },
      ],
    }),
  ]);
  expect(integrityWords(mixed)).toBe("Damaged files found: 2 files");
});

test("a delete command removes every name of its address, never the first", () => {
  const item = state([
    report({
      problem: true,
      addresses: [
        {
          logical: 953118621696,
          paths: [
            "/r/target/debug/build/glib-sys/build-script-build",
            "/r/target/debug/build/glib-sys/build_script_build-c664",
          ],
        },
        { logical: 2, paths: ["/home/r/letter.txt"] },
        { logical: 3, paths: [] },
      ],
    }),
  ]);
  // Both names in one line. Deleting the first alone leaves the extent on
  // disk, and the next check reports it again.
  expect(deleteCommand(item.groups[0])).toBe(
    "rm -f /r/target/debug/build/glib-sys/build-script-build /r/target/debug/build/glib-sys/build_script_build-c664",
  );
  // An address with no file has nothing to delete.
  expect(deleteCommand(item.groups[2])).toBeUndefined();
  expect(item.groups.map(damageAdvice)).toEqual([
    "safe to delete and rebuild",
    "restore from a backup or a snapshot",
    "free space or already deleted, clears on the next check",
  ]);
  // The one-line command covers build output only: the letter is not in it.
  expect(rebuildCommand(item)).toBe(
    "rm -f /r/target/debug/build/glib-sys/build-script-build /r/target/debug/build/glib-sys/build_script_build-c664",
  );
  expect(rebuildCommand(state([report()]))).toBeUndefined();
});

test("an absent damaged-file list never reads as a check that found none", () => {
  // Three different facts, told apart: nothing checked, a report that cannot
  // name files, and a check that named none.
  expect(noDamageText(state([]))).toBe(
    "No check has reported on this filesystem, so no file is named.",
  );
  expect(noDamageText(state([report({ addresses: null })]))).toBe(
    "The report carries no damaged-file section, so it names no file. That is not a report of none.",
  );
  expect(noDamageText(state([report()]))).toBe(
    "No damaged address is left on this filesystem.",
  );
});
