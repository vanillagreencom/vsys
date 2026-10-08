import { expect, test } from "bun:test";
import { defaults } from "../config/config";
import { point } from "../store/point";
import { emptySnapshot, processSnapshot } from "../test/fixture";
import { mount } from "../test/harness";
import { present } from "../test/present";
import { gap } from "./format";

test("A3-2 incomplete process reads keep escaped and token counts unknown", async () => {
  const c = defaults();
  const s = emptySnapshot();
  s.processRead = "incomplete";
  s.procs = [
    processSnapshot({
      tool: null,
      build: "rustc",
      env: { MAKEFLAGS: "-j4 --jobserver-auth=fifo:/fixture/pool" },
    }),
  ];
  const t = await mount(s, c, { width: 220, height: 35 });
  const tokens = () => {
    const lines = t.frame().split("\n");
    const index = lines.findIndex((line) => line.includes("Make tokens"));
    const heading = present(lines[index], "token heading");
    return present(lines[index + 1], "token value")
      .slice(heading.indexOf("Make tokens"))
      .trim();
  };
  try {
    await t.press("4");
    const partialTokens = tokens();
    await t.update({ ...s, procs: [] });
    expect({
      escaped: point(s, c).unconfined,
      partialTokens,
      noReadableTokens: tokens(),
    }).toEqual({ escaped: null, partialTokens: gap, noReadableTokens: gap });
    expect(point({ ...s, processRead: "complete" }, c).unconfined).toBe(0);
  } finally {
    await t.close();
  }
});
