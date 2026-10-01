import { afterEach } from "bun:test";
import { format } from "node:util";

/**
 * Fails the test during which anything wrote to `console.error` or
 * `console.warn`. React reports a duplicate or missing key, an update outside
 * `act`, and invalid nesting through those two calls in development, and goes
 * on rendering; printed alone, the warning passes the run. Each message still
 * prints where it was written, and the failure repeats its text.
 *
 * `bunfig.toml` preloads this module before any suite imports React, so the
 * reconciler reads the wrapped calls. A warning that a timer writes after its
 * test has ended fails the next test to finish, which the failure says.
 */
const written: string[] = [];

for (const level of ["error", "warn"] as const) {
  const print = console[level];
  console[level] = (...args: unknown[]) => {
    written.push(`console.${level}: ${format(...args)}`);
    print(...args);
  };
}

afterEach(() => {
  if (written.length === 0) return;
  const text = written.splice(0).join("\n");
  throw new Error(
    `console-warning: written during this test or since the last one ended\n${text}`,
  );
});
