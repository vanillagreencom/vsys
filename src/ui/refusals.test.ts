import { expect, test } from "bun:test";
import { ConfigError } from "../config/config";
import { ArgumentError } from "../main";
import { SettingsError } from "../runtime";
import { ArchiveError } from "../store/archive";
import { WardenError } from "../warden";
import { errorText } from "./refusals";

// Each typed refusal against the identifiers its text has to name. An error
// carries its kind as its message, so text equal to the kind is a refusal
// that reached the reader unwritten.
const rows: [
  ConfigError | SettingsError | ArchiveError | WardenError | ArgumentError,
  string[],
][] = [
  [
    new ConfigError({
      kind: "keybinding-clash",
      clashes: [{ key: "x", actions: ["scratch", "help", "quit"] }],
    }),
    ["x", "scratch", "help", "quit"],
  ],
  [new ConfigError({ kind: "pressure-order" }), []],
  [new ConfigError({ kind: "multi-line-value", key: "columns" }), ["columns"]],
  [
    new ConfigError({ kind: "untouched-value-changed", key: "procRoot" }),
    ["procRoot"],
  ],
  [
    new ConfigError(
      { kind: "save-unloadable" },
      { cause: new Error("planted loader failure") },
    ),
    ["planted loader failure"],
  ],
  [
    new SettingsError({ kind: "pinned-omits-shipped", missing: ["a", "b"] }),
    ["a", "b"],
  ],
  [new SettingsError({ kind: "overlay-changed" }), []],
  [
    new SettingsError({
      kind: "rollback-skipped",
      saveError: new Error("save"),
      rollbackError: new Error("rollback"),
    }),
    [],
  ],
  [
    new SettingsError({
      kind: "rollback-failed",
      saveError: new Error("save"),
      rollbackError: new Error("rollback"),
    }),
    [],
  ],
  [
    new ArchiveError({ kind: "invalid-column", table: "procs", field: "pid" }),
    ["procs", "pid"],
  ],
  [
    new ArchiveError({
      kind: "short-column",
      table: "lanes",
      field: "cpu",
      row: 7,
    }),
    ["lanes", "cpu", "7"],
  ],
  [new ArchiveError({ kind: "missing-line", line: 3 }), ["3"]],
  [new ArchiveError({ kind: "over-budget" }), []],
  [
    new WardenError({ kind: "installer-not-found", tried: ["/a", "/b"] }),
    ["/a", "/b"],
  ],
  [new ArgumentError({ kind: "needs-once" }), []],
];

test.each(
  rows.map(([error, ids]) => [error.refusal.kind, error, ids] as const),
)(
  "a typed refusal reaches the reader written out: %s",
  (_kind, error, identifiers) => {
    const text = errorText(error);
    expect(text).not.toBe(error.refusal.kind);
    expect(text).not.toBe("");
    for (const identifier of identifiers) expect(text).toContain(identifier);
  },
);

test("a save the loader refuses is told in its cause's own written text", () => {
  const cause = new ConfigError({
    kind: "untouched-value-changed",
    key: "procRoot",
  });
  const text = errorText(
    new ConfigError({ kind: "save-unloadable" }, { cause }),
  );
  expect(text).toContain("procRoot");
  expect(text).not.toContain(cause.refusal.kind);
});

test("an untyped failure speaks in its own message", () => {
  expect(errorText(new Error("planted"))).toBe("planted");
  expect(errorText("planted")).toBe("planted");
});
