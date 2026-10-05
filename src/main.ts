#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type Collector, createCollector } from "./collect/collector";
import { capturePane, insideTmux } from "./collect/tmux";
import { agentToolsPath } from "./config/agent-tools";
import { configPath, loadConfig } from "./config/config";
import { runEffect, switchToPane } from "./effect";
import { exportSnapshot, exportSummary } from "./model/export";
import { Session } from "./runtime";
import { History } from "./store/history";
import { errorText } from "./ui/refusals";
import { dispatchWarden } from "./warden";

/**
 * The refusals a caller or a test tells apart. `errorText()` in
 * `src/ui/refusals.ts` writes what the reader sees.
 */
export type ArgumentRefusal = { kind: "needs-once" };

export class ArgumentError extends Error {
  constructor(readonly refusal: ArgumentRefusal) {
    super(refusal.kind);
  }
}

export async function sampleSummary(
  collector: Pick<Collector, "sample">,
  pause: () => Promise<void> = () => Bun.sleep(100),
  now: () => number = Date.now,
) {
  const cheap = { skipScratch: true, skipKernelLog: true };
  const first = await collector.sample(now(), undefined, cheap);
  await pause();
  const snapshot = await collector.sample(now(), undefined, cheap);
  return { snapshot, errors: [...first.errors, ...snapshot.errors] };
}

/** --once produces a sample without starting a terminal renderer. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] === "warden") await dispatchWarden(args.slice(1));
  const { values } = parseArgs({
    args,
    options: {
      once: { type: "boolean" },
      summary: { type: "boolean" },
      markdown: { type: "boolean" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "vsys [--once] [--summary] [--markdown] [--config PATH]\nvsys warden install|uninstall|status\n\nObserve Linux agent processes and system health.\n--once      Print a JSON snapshot and exit (status 2 for source errors).\n--summary   With --once, print a cheap verdict JSON and skip scratch collection.\n--markdown  Print the snapshot as Markdown; requires --once.\n--config    Use another TOML settings file.\n\nInteractive exports write to the current directory. Settings and optional\nSQLite history write only to their configured application paths. The agent\nactions that freeze, thaw or stop a scope run only with writeMode on in the\nsettings file, and only after a confirmation.",
    );
    return;
  }
  if (process.platform !== "linux")
    throw new Error("vsys requires Linux with cgroup v2");
  if (values.markdown && !values.once)
    throw new Error("--markdown requires --once");
  if (values.summary && !values.once)
    throw new ArgumentError({ kind: "needs-once" });
  if (values.summary && values.markdown)
    throw new Error("--summary and --markdown cannot be combined");
  if (values.config === "") throw new Error("Config path cannot be empty");
  const explicit =
    values.config !== undefined ? resolve(values.config) : undefined;
  const settingsPath = () => explicit ?? configPath();
  const config = await loadConfig(settingsPath());
  const collector = await createCollector(config, !values.once);
  if (values.once) {
    try {
      if (values.summary) {
        const { snapshot, errors } = await sampleSummary(collector);
        console.log(
          exportSummary(snapshot, config, errors, { scratchMeasured: false }),
        );
        if (errors.length) process.exitCode = 2;
      } else {
        const snapshot = await collector.sample();
        console.log(
          exportSnapshot(snapshot, values.markdown ? "markdown" : "json"),
        );
        if (snapshot.errors.length) process.exitCode = 2;
      }
    } finally {
      collector.close();
    }
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY)
    throw new Error(
      "Interactive mode needs a terminal; use --once for scripts",
    );
  const [{ CliRenderEvents, createCliRenderer }, { mountScreen }] =
    await Promise.all([import("@opentui/core"), import("./ui/screen")]);
  const history = new History(config);
  let stopped = false;
  let renderer: Awaited<ReturnType<typeof createCliRenderer>>;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      useMouse: true,
      targetFps: Number.POSITIVE_INFINITY,
      maxFps: Number.POSITIVE_INFINITY,
    });
  } catch (error) {
    history.close();
    throw error;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    for (const cleanup of [
      () => session.stop(),
      () => screen.close(),
      () => renderer.destroy(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      console.error(`vsys shutdown: ${errors.map(String).join("; ")}`);
      process.exitCode = 1;
    }
  }
  const screen = mountScreen(renderer, config, {
    onQuit: stop,
    onSave: (next) => session.configure(next),
    onExport: async (snapshot, format) => {
      const file = resolve(
        `vsys-${new Date(snapshot.time).toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.${format === "json" ? "json" : "md"}`,
      );
      await writeFile(file, exportSnapshot(snapshot, format), {
        flag: "wx",
        mode: 0o600,
      });
      return file;
    },
    // The shell refuses every action on a pinned sample and every action while
    // write mode is off; reaching here means the reader turned it on and
    // confirmed this exact command against live data.
    onAction: ({ effect }) => runEffect(effect),
    // Reading a pane and moving the reader's view touch no process, so neither
    // is an action. The switch is offered only from inside a tmux client,
    // because outside one there is no view to move.
    onCapture: capturePane,
    ...(insideTmux(process.env) ? { onSwitch: switchToPane } : {}),
    output: process.stdout,
  });
  const session = new Session(
    config,
    settingsPath,
    collector,
    history,
    {
      frame: screen.update,
      error: (error) => {
        stop();
        console.error(`vsys: ${errorText(error)}`);
        process.exitCode = 1;
      },
    },
    { agentToolsPath },
  );
  // The renderer listens for the exit signals, a hangup among them, and
  // destroys itself on one. Its listener also keeps the process from dying, so
  // every way the renderer ends must lead here, or sampling outlives the
  // terminal. The event fires before the renderer gives the console and the
  // terminal back, so shutdown waits for that or its failure report is lost.
  renderer.once(CliRenderEvents.DESTROY, () => queueMicrotask(stop));
  session.start();
}

if (import.meta.main)
  main().catch((error) => {
    console.error(`vsys: ${errorText(error)}`);
    process.exitCode = 1;
  });
