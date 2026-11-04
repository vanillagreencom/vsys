import { expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { defaults } from "../config/config";
import { emptySnapshot } from "../test/fixture";
import { mount } from "../test/harness";
import { Footer } from "./chrome";

// App supplies this delivered status; mounting Footer with a string cannot test it.
test.each([
  { sources: [], status: "all clear" },
  { sources: ["/scratch"], status: "1 source unreadable" },
  {
    sources: ["/scratch", "/scratch", "/cgroup"],
    status: "2 sources unreadable",
  },
])(
  "the footer counts distinct unreadable sources: %j",
  async ({ sources, status }) => {
    const s = emptySnapshot();
    s.errors = sources.map((source) => ({ source, message: "EACCES" }));
    const t = await mount(s, defaults());
    try {
      await t.ui.renderOnce();
      expect(t.frame().trimEnd().endsWith(`  ${status}`)).toBe(true);
    } finally {
      await t.close();
    }
  },
);

// The machine status must stay visible with a separating blank even when hints
// exceed the row.
test.each([60, 80, 90, 120])(
  "the footer keeps the standing whole after a gap at %i columns",
  async (width) => {
    const hints: [string, string][] = Array.from({ length: 8 }, (_, i) => [
      `k${i}`,
      `action ${i}`,
    ]);
    const status = "standing";
    const screen = await testRender(<Footer hints={hints} status={status} />, {
      width,
      height: 1,
    });
    try {
      await screen.renderOnce();
      const row = screen.captureCharFrame().split("\n")[0] ?? "";
      expect(row.trimEnd().endsWith(`  ${status}`)).toBe(true);
    } finally {
      await act(async () => {
        screen.renderer.destroy();
      });
    }
  },
);
