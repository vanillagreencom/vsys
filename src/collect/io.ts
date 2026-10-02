import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import type { Pressure, SourceError } from "../model/types";

/** Source access is read-only. Optional kernel interfaces may be absent. */
export class Reader {
  errors: SourceError[] = [];
  error(source: string, error: unknown): void {
    this.errors.push({
      source,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  text(path: string, optional = false): string | null {
    return this.exact(path, optional)?.trim() ?? null;
  }
  /**
   * A file's text as written. A report names files a line each, and trimming
   * its last line would turn one name into another.
   */
  exact(path: string, optional = false): string | null {
    try {
      return readFileSync(path, "utf8");
    } catch (e) {
      if (!(optional && (e as NodeJS.ErrnoException).code === "ENOENT"))
        this.error(path, e);
      return null;
    }
  }
  dirs(path: string, optional = false): string[] {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (e) {
      if (!(optional && (e as NodeJS.ErrnoException).code === "ENOENT"))
        this.error(path, e);
      return [];
    }
  }
  names(path: string, optional = false): string[] {
    try {
      return readdirSync(path);
    } catch (e) {
      if (!(optional && (e as NodeJS.ErrnoException).code === "ENOENT"))
        this.error(path, e);
      return [];
    }
  }
  link(path: string): string | null {
    try {
      return readlinkSync(path);
    } catch (e) {
      if (
        !["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")
      )
        this.error(path, e);
      return null;
    }
  }
  /**
   * A cgroup limit file holds a number or the word max. Those are both
   * answers; a file that could not be read is not, so the caller can tell an
   * absent limit from an unknown one.
   */
  limit(
    path: string,
    optional = false,
  ): { value: number | null; read: boolean } {
    const value = this.text(path, optional);
    if (value === null) return { value: null, read: false };
    if (value === "max") return { value: null, read: true };
    if (!/^\d+$/.test(value)) {
      this.error(path, "Invalid integer");
      return { value: null, read: false };
    }
    return { value: Number(value), read: true };
  }
  number(path: string, optional = false): number | null {
    const value = this.text(path, optional);
    if (value === null || value === "max") return null;
    if (!/^\d+$/.test(value)) {
      this.error(path, "Invalid integer");
      return null;
    }
    return Number(value);
  }
}

/**
 * Run a program and keep everything it said. The exit status is returned
 * rather than judged, because what counts as a refusal is the caller's:
 * journalctl exits 1 when a search matched nothing, which is an answer.
 */
export async function spawnText(
  argv: string[],
): Promise<{ out: string; error: string; status: number }> {
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { out, error, status };
}
/** Kernel key/value files carry bytes, microseconds, or counters by source. */
export function pairs(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [key, raw, unit] = line.trim().split(/\s+/);
    if (key === undefined || raw === undefined || !/^\d+(\.\d+)?$/.test(raw))
      throw new Error(`Invalid numeric field: ${key}`);
    result[key.replace(/:$/, "")] = Number(raw) * (unit === "kB" ? 1024 : 1);
  }
  return result;
}
/** avg10 is the recent stall fraction; total is cumulative microseconds. */
export function pressure(text: string): Pressure {
  const rows = text.split("\n").map((line) => line.split(/\s+/));
  const read = (kind: string, field: string): number | null => {
    const token = rows
      .find((r) => r[0] === kind)
      ?.find((v) => v.startsWith(`${field}=`));
    if (!token) return null;
    const n = Number(token.split("=")[1]);
    if (!Number.isFinite(n) || n < 0) throw new Error("Invalid pressure value");
    return n;
  };
  const some = read("some", "avg10");
  const total = read("some", "total");
  if (some === null || total === null)
    throw new Error("Missing pressure fields");
  return { some, total, full: read("full", "avg10") };
}
export function readPressure(
  r: Reader,
  root: string,
): Record<string, Pressure | null> {
  return Object.fromEntries(
    ["cpu", "memory", "io"].map((kind) => {
      const path = `${root}/${kind}`;
      const raw = r.text(path, true);
      try {
        return [kind, raw === null ? null : pressure(raw)];
      } catch (e) {
        r.error(path, e);
        return [kind, null];
      }
    }),
  );
}
