import { afterEach, expect, test } from "bun:test";
import { lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { defaults, loadConfig, saveConfig, validate } from "./config";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});
test("TOML settings round-trip, including quotes and custom keys", async () => {
  const f = fixture();
  fixtures.push(f);
  const path = join(f.root, "settings/config.toml");
  const c = defaults();
  c.laneEnv = 'LANE_"NAME';
  c.keys.quit = "ctrl+q";
  await saveConfig(c, path);
  expect(await loadConfig(path)).toEqual(c);
});
test("invalid settings stop loading", () => {
  for (const value of [
    { refreshMs: 0 },
    { historyHours: -1 },
    { pressureAmber: 101 },
    { pressureHoldSeconds: Number.NaN },
    { persistence: "false" },
    { watchedSlices: ["../agents.slice"] },
    { columns: [] },
    { sort: "nope" },
    { notifications: ["unknown"] },
    { laneNameParts: ["hostname"] },
    { keys: { quit: "j" } },
    { sqlitePath: "relative" },
    { unknown: 1 },
  ])
    expect(() => validate(value)).toThrow();
});
test("saving linked settings preserves the link and updates its target", async () => {
  const f = fixture();
  fixtures.push(f);
  const target = join(f.root, "target.toml");
  const link = join(f.root, "config.toml");
  await saveConfig(f.config, target);
  symlinkSync(target, link);
  const next = { ...f.config, refreshMs: 2000 };
  await saveConfig(next, link);
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(await loadConfig(target)).toEqual(next);
});
test("missing config uses defaults but malformed TOML fails", async () => {
  const f = fixture();
  fixtures.push(f);
  const path = join(f.root, "config.toml");
  expect(await loadConfig(path)).toEqual(defaults());
  f.write(path, "refreshMs = [");
  expect(loadConfig(path)).rejects.toThrow();
});
