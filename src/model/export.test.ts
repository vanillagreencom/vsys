import { expect, test } from "bun:test";
import { emptySnapshot } from "../test/fixture";
import { exportJson, safe } from "./export";

test("JSON preserves evidence and display text removes terminal controls", () => {
  const s = emptySnapshot();
  expect(JSON.parse(exportJson(s))).toEqual(s);
  expect(safe("a\u001b[2J\nb")).toBe("a [2J b");
});
