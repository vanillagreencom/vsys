import { expect, test } from "bun:test";
import { cacheText } from "./builds-screen";

test("the cache reading states its window and never divides by nothing", () => {
  expect(cacheText(null)).toBe("not available");
  expect(cacheText({ hits: 0, misses: 0, rate: null, windowMs: 300000 })).toBe(
    "no requests over 5m",
  );
  expect(cacheText({ hits: 3, misses: 1, rate: 75, windowMs: 0 })).toBe(
    "75.0% hits · 3 hits, 1 miss over no elapsed time",
  );
  expect(cacheText({ hits: 1, misses: 3, rate: 25, windowMs: 60000 })).toBe(
    "25.0% hits · 1 hit, 3 misses over 1m",
  );
});
