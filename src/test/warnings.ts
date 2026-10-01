import { afterAll, afterEach } from "bun:test";
import { format } from "node:util";

/**
 * Fails the test during which anything wrote to `console.error` or
 * `console.warn`. React reports a duplicate or missing key, an update outside
 * `act`, and invalid nesting through those two calls in development, and goes
 * on rendering; printed alone, the warning passes the run. Each message still
 * prints where it was written, and the failure repeats its text.
 *
 * `bunfig.toml` preloads this module before any suite imports React, so the
 * reconciler reads the wrapped calls. Bun reads that file from the directory
 * it starts in, so a run started elsewhere has no gate; a flag on
 * `globalThis` lets `warnings.test.ts` say so. A warning written after its
 * test has ended fails the next test to finish, or the end of the run when no
 * test follows.
 */
const written: string[] = [];

// Read by `warnings.test.ts` by key, since importing this module would load
// the gate and hide that the preload did not.
(globalThis as Record<symbol, unknown>)[Symbol.for("vsys.warning-gate")] = true;

for (const level of ["error", "warn"] as const) {
  const print = console[level];
  console[level] = (...args: unknown[]) => {
    written.push(`console.${level}: ${format(...args)}`);
    print(...args);
  };
}

function drain(when: string) {
  if (written.length === 0) return;
  const text = written.splice(0).join("\n");
  throw new Error(`console-warning: written ${when}\n${text}`);
}

afterEach(() => drain("during this test or since the last one ended"));
// In a preload, this runs once, after every file's own afterAll.
afterAll(() => drain("after the last test ended"));
