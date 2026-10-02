import { expect, test } from "bun:test";
import { type ToolSignals, toolName } from "./builds";

function signalsFor(fragments: string[]): ToolSignals {
  return {
    installs: new Map([
      ["claude", { fragments, executables: [] }],
      ["pi", { fragments, executables: [] }],
    ]),
    desktop: { desktopExePrefixes: [], bundledCliSuffixes: [] },
  };
}

test("an unconfirmed match carries the one path toolName tested, executable or script", () => {
  const signals = signalsFor(["/opt/claude/", "/opt/pi/"]);
  // A name match: `claude`'s own executable is the path tested, and it lies
  // outside the tool's install location.
  const named = toolName(
    "claude",
    ["/usr/bin/claude"],
    ["claude", "pi"],
    signals,
    {
      executable: () => "/usr/bin/claude",
      script: () => null,
    },
  );
  expect(named).toEqual({
    kind: "unconfirmed",
    name: "claude",
    path: "/usr/bin/claude",
    matchedBy: "name",
  });
  // A scripted match: node's own executable is never tested here, only the
  // script it runs, and that script lies outside the tool's install location.
  const scripted = toolName(
    "node",
    ["/usr/bin/node", "/home/reader/scripts/pi.js"],
    ["claude", "pi"],
    signals,
    { executable: () => "/usr/bin/node", script: (argument) => argument },
  );
  expect(scripted).toEqual({
    kind: "unconfirmed",
    name: "pi",
    path: "/home/reader/scripts/pi.js",
    matchedBy: "script",
  });
  // The interpreter's own directory would confirm nothing: a card that named
  // it instead of the script would point the reader at the wrong fix.
  expect(scripted.kind === "unconfirmed" && scripted.path).not.toBe(
    "/usr/bin/node",
  );
});

test("a scripted match against a tool with no install location still carries the script path", () => {
  // `pi` has no fragments and no executables at all: a script never confirms
  // such a tool, so this always falls through to unconfirmed, but nothing
  // short-circuits the script path to null the way an install-location
  // rejection does, so it has to be read here instead.
  const signals: ToolSignals = {
    installs: new Map([["pi", { fragments: [], executables: [] }]]),
    desktop: { desktopExePrefixes: [], bundledCliSuffixes: [] },
  };
  const scripted = toolName(
    "bash",
    ["bash", "/home/reader/bin/pi.sh"],
    ["pi"],
    signals,
    {
      executable: () => "/usr/bin/bash",
      script: (argument) => argument,
    },
  );
  expect(scripted).toEqual({
    kind: "unconfirmed",
    name: "pi",
    path: "/home/reader/bin/pi.sh",
    matchedBy: "script",
  });
});

test("an unreadable script against a tool with no install location carries a null path, not a throw", () => {
  // The lazy read this case takes can itself fail. A failed read never hides
  // the unconfirmed name, so toolName() reports the name with no path rather
  // than throwing, which would otherwise drop the whole process one layer up.
  const signals: ToolSignals = {
    installs: new Map([["pi", { fragments: [], executables: [] }]]),
    desktop: { desktopExePrefixes: [], bundledCliSuffixes: [] },
  };
  const scripted = toolName(
    "bash",
    ["bash", "/home/reader/bin/pi.sh"],
    ["pi"],
    signals,
    {
      executable: () => "/usr/bin/bash",
      script: () => null,
    },
  );
  expect(scripted).toEqual({
    kind: "unconfirmed",
    name: "pi",
    path: null,
    matchedBy: "script",
  });
});
