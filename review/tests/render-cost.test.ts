// Findings 4 and 5: the cost of drawing one sample on the dashboard thread
// once a day of history is retained. Run from the repository root:
//   bun test ./review/tests/render-cost.test.ts
// Each case runs render-cost.driver.tsx in a child Bun, because which React
// build loads is decided by NODE_ENV when the process starts. Real elapsed
// time is the claim; the budget is half the refresh interval, the share
// docs/architecture/history.md gives a sample's history writes.
import { expect, test } from "bun:test";
import { join } from "node:path";

const driver = join(import.meta.dir, "render-cost.driver.tsx");
type Costs = { home5m: number; home24h: number; timeline24h: number };

async function drive(refreshMs: number, nodeEnv: string | null) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (nodeEnv !== null) env.NODE_ENV = nodeEnv;
  const child = Bun.spawn([process.execPath, driver, String(refreshMs)], {
    cwd: join(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const out = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const costs = JSON.parse(out) as Costs;
  console.log(`refreshMs ${refreshMs} NODE_ENV ${nodeEnv}: ${out.trim()}`);
  return costs;
}

test("control: production React draws a day at the default refresh in budget", async () => {
  const costs = await drive(1000, "production");
  expect(costs.home24h).toBeLessThan(500);
  expect(costs.timeline24h).toBeLessThan(500);
}, 300000);

test("finding 4: the program as shipped draws a day at the default refresh in budget", async () => {
  // NODE_ENV unset, as `bun src/main.ts`, `bun dist/main.js` and the
  // compiled binary run: React's development build loads.
  const costs = await drive(1000, null);
  expect(costs.home24h).toBeLessThan(500);
  expect(costs.timeline24h).toBeLessThan(500);
}, 300000);

test("finding 5: even production React draws a day at refreshMs 100 in budget", async () => {
  const costs = await drive(100, "production");
  expect(costs.home24h).toBeLessThan(50);
  expect(costs.timeline24h).toBeLessThan(50);
}, 600000);
