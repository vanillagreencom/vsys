// Findings 4 and 5. Driven by render-cost.test.ts in a child Bun, once as the
// program runs (NODE_ENV unset, as `bun src/main.ts`, `bun dist/main.js` and the compiled
// binary all run) and once with NODE_ENV=production. It mounts the program's
// own screen through mountScreen() on OpenTUI's test renderer, fills a
// History with a full retention window of quiet samples, steps the window key
// to 24 h, and prints the median time to take one sample into the history
// and draw it, on Home and on the Timeline.
//
// Usage: bun review/tests/render-cost.driver.tsx <refreshMs>
import { createTestRenderer } from "@opentui/core/testing";
import { defaults } from "../../src/config/config";
import { History } from "../../src/store/history";
import { emptySnapshot } from "../../src/test/fixture";
import { mountScreen } from "../../src/ui/screen";
import { windows } from "../../src/ui/timeline-screen";

const refreshMs = Number(process.argv[2]);
if (!Number.isFinite(refreshMs)) throw new Error("usage: <refreshMs>");
const config = {
  ...defaults(),
  refreshMs,
  historyHours: 24,
  persistence: false,
};
const history = new History(config);
let time = 1_800_000_000_000;
const end = time + config.historyHours * 3600000;
for (; time < end; time += refreshMs) history.add(emptySnapshot(time));

const setup = await createTestRenderer({ width: 160, height: 40 });
const screen = mountScreen(setup.renderer, config, {
  onQuit: () => {},
  onSave: async () => {},
  onExport: async () => "snapshot.json",
  onAction: async () => {},
  output: { write: () => {} },
});
const sample = async () => {
  time += refreshMs;
  const s = emptySnapshot(time);
  const started = performance.now();
  history.add(s);
  screen.update(s, history, config, "/tmp/config.toml");
  await Bun.sleep(0);
  await setup.renderOnce();
  return performance.now() - started;
};
const median = async () => {
  const costs: number[] = [];
  for (let i = 0; i < 5; i++) costs.push(await sample());
  costs.sort((a, b) => a - b);
  return Math.round(costs[2] ?? Number.NaN);
};
// React commits a key's state change on a later turn, so the press waits for
// one before it draws.
const press = async (key: string) => {
  setup.mockInput.pressKey(key);
  await Bun.sleep(20);
  await setup.renderOnce();
};
await sample();
const result: Record<string, number | string> = {
  nodeEnv: process.env.NODE_ENV ?? "unset",
  points: Math.round((config.historyHours * 3600000) / refreshMs),
  home5m: await median(),
};
for (let i = 1; i < windows.length; i++) await press(config.keys.window);
result.home24h = await median();
await press(config.keys.timeline);
const frame = setup.captureCharFrame();
if (!frame.includes("of 24.0h")) throw new Error("timeline-window: not 24h");
result.timeline24h = await median();
screen.close();
setup.renderer.destroy();
console.log(JSON.stringify(result));
process.exit(0);
