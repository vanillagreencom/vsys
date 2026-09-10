#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createCollector } from "./collect/collector";
import { configPath, loadConfig } from "./config/config";
import { runEffect } from "./effect";
import { exportSnapshot } from "./model/export";
import { Session } from "./runtime";
import { History } from "./store/history";

/** --once produces a sample without starting a terminal renderer. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      once: { type: "boolean" },
      markdown: { type: "boolean" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "vsys-view [--once] [--markdown] [--config PATH]\n\nObserve Linux agent processes and system health.\n--once      Print a JSON snapshot and exit (status 2 for source errors).\n--markdown  Print the snapshot as Markdown; requires --once.\n--config    Use another TOML settings file.\n\nInteractive exports write to the current directory. Settings and optional\nSQLite history write only to their configured application paths. The agent\nactions that freeze, thaw or stop a scope run only with writeMode on in the\nsettings file, and only after a confirmation.",
    );
    return;
  }
  if (process.platform !== "linux")
    throw new Error("vsys-view requires Linux with cgroup v2");
  if (values.markdown && !values.once)
    throw new Error("--markdown requires --once");
  if (values.config === "") throw new Error("Config path cannot be empty");
  const path =
    values.config !== undefined ? resolve(values.config) : configPath;
  const config = await loadConfig(path);
  const collector = await createCollector(config, !values.once);
  if (values.once) {
    const snapshot = await collector.sample().finally(() => collector.close());
    console.log(
      exportSnapshot(snapshot, values.markdown ? "markdown" : "json"),
    );
    if (snapshot.errors.length) process.exitCode = 2;
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY)
    throw new Error(
      "Interactive mode needs a terminal; use --once for scripts",
    );
  const [{ createCliRenderer }, { mountScreen }] = await Promise.all([
    import("@opentui/core"),
    import("./ui/screen"),
  ]);
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
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (errors.length) {
      console.error(`vsys-view shutdown: ${errors.map(String).join("; ")}`);
      process.exitCode = 1;
    }
  }
  const screen = mountScreen(renderer, config, {
    onQuit: stop,
    onSave: (next) => session.configure(next),
    onExport: async (snapshot, format) => {
      const file = resolve(
        `vsys-view-${new Date(snapshot.time).toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.${format === "json" ? "json" : "md"}`,
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
    output: process.stdout,
  });
  const session = new Session(config, path, collector, history, {
    frame: screen.update,
    error: (error) => {
      stop();
      console.error(
        `vsys-view: ${error instanceof Error ? error.message : error}`,
      );
      process.exitCode = 1;
    },
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  session.start();
}

if (import.meta.main)
  main().catch((error) => {
    console.error(`vsys-view: ${error.message}`);
    process.exitCode = 1;
  });
