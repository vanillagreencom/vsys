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
    try {
      return readFileSync(path, "utf8").trim();
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

/** Kernel key/value files carry bytes, microseconds, or counters by source. */
export function pairs(text: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [key, raw, unit] = line.trim().split(/\s+/);
    if (!/^\d+(\.\d+)?$/.test(raw ?? ""))
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
