import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Median draw time of Home and Timeline with a full day retained at
 * `refreshMs`, measured in a child process so production React is the one
 * loaded, as the compiled binary ships it.
 */
async function measure(refreshMs: number) {
  // Inside the repository so the child resolves the installed renderer packages.
  const repo = process.cwd();
  const root = mkdtempSync(join(repo, "src/ui/a6-render-"));
  const driver = join(root, "driver.tsx");
  const from = (path: string) => JSON.stringify(join(repo, path));
  writeFileSync(
    driver,
    `
    import { createTestRenderer } from "@opentui/core/testing";
    import { defaults } from ${from("src/config/config.ts")};
    import { History } from ${from("src/store/history.ts")};
    import { emptySnapshot } from ${from("src/test/fixture.ts")};
    import { mountScreen } from ${from("src/ui/screen.tsx")};
    import { windows } from ${from("src/ui/timeline-screen.tsx")};
    const c = { ...defaults(), refreshMs: ${refreshMs} };
    const h = new History(c);
    const count = c.historyHours * 3600000 / c.refreshMs;
    let time = 0;
    for (let i = 0; i < count; i++) h.add(emptySnapshot(time += c.refreshMs));
    if (h.window(time, 86400000).length !== count) throw new Error("fixture window incomplete");
    const readWindow = h.window.bind(h);
    let lastWindow = 0;
    h.window = (end, duration) => { lastWindow = duration; return readWindow(end, duration); };
    const ui = await createTestRenderer({ width: 140, height: 35, maxFps: Infinity });
    const screen = mountScreen(ui.renderer, c, {
      onQuit: () => {}, onSave: async () => {}, onExport: async () => "unused",
      onAction: async () => {}, output: { write: () => {} },
    });
    const draw = async (ready = () => true) => {
      for (let pass = 0; pass < 100; pass++) {
        await Bun.sleep(0); await ui.renderOnce();
        if (ready()) { await Bun.sleep(0); await ui.renderOnce(); return; }
      }
      throw new Error("render did not complete");
    };
    const update = async () => {
      const s = emptySnapshot(time += c.refreshMs);
      s.system.host = "sample-" + time;
      h.add(s); screen.update(s, h, c, "fixture.toml");
      await draw(() => ui.captureCharFrame().includes(s.system.host));
    };
    const median = async () => {
      await update();
      const samples = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now(); await update(); samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      return samples[2];
    };
    try {
      await update();
      if (!ui.captureCharFrame().includes("Home")) throw new Error("screen did not mount");
      const short = await median();
      for (let i = 1; i < windows.length; i++) {
        ui.mockInput.pressKey(c.keys.window); await draw(() => lastWindow === windows[i]);
      }
      if (lastWindow !== 86400000) throw new Error("day window not selected: " + lastWindow);
      const home = await median();
      ui.mockInput.pressKey(c.keys.timeline);
      await draw(() => ui.captureCharFrame().includes("Agents CPU"));
      if (!ui.captureCharFrame().includes("Agents CPU")) throw new Error("timeline not selected");
      const timeline = await median();
      console.log(JSON.stringify({ count, short, home, timeline }));
    } finally { screen.close(); ui.renderer.destroy(); h.close(); }
  `,
  );
  const child = Bun.spawn([process.execPath, driver], {
    env: {
      PATH: join(repo, "node_modules/.bin"),
      HOME: root,
      TMPDIR: root,
      NODE_ENV: "production",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  try {
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(error).toBe("");
    expect(code).toBe(0);
    return JSON.parse(out) as {
      count: number;
      short: number;
      home: number;
      timeline: number;
    };
  } finally {
    clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  }
}

test("A6-5: production React renders the retained day within a 100 ms refresh interval", async () => {
  const result = await measure(100);
  expect(result.count).toBe(864000);
  expect(result.short).toBeLessThan(100);
  expect(Math.max(result.home, result.timeline)).toBeLessThan(100);
}, 120000);
