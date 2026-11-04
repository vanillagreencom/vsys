import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { fixture } from "../test/fixture";
import { present } from "../test/present";
import { Reader } from "./io";
import { ProcessCollector } from "./procs";

// Forward the full fs overload contract unchanged outside the planted refusal.
function refusing<T extends (...args: never[]) => unknown>(
  read: T,
  denied: ReadonlySet<string>,
  code: string,
): T {
  return new Proxy(read, {
    apply(target, receiver: unknown, args: unknown[]) {
      if (denied.has(String(args[0])))
        throw Object.assign(new Error(code), { code });
      return Reflect.apply(target, receiver, args);
    },
  });
}

test.each(["EACCES", "EPERM", "ENOENT", "ESRCH", "EIO"])(
  "withheld process details stay unknown without masking failed reads: %s",
  (code) => {
    const f = fixture();
    const group = "agents.slice/a.scope";
    f.proc(40, group, { parent: 41 });
    f.proc(41, group, { comm: "bash", command: ["bash"], parent: 0 });
    const details = [
      join(f.config.procRoot, "40/cwd"),
      join(f.config.procRoot, "40/exe"),
      join(f.config.procRoot, "40/environ"),
      join(f.config.procRoot, "41/cwd"),
      join(f.config.procRoot, "41/exe"),
    ];
    const denied = new Set(details);
    const read = fs.readFileSync;
    const link = fs.readlinkSync;
    // procfs emits these errnos for protected or vanished process details.
    const text = spyOn(fs, "readFileSync").mockImplementation(
      refusing(read, denied, code),
    );
    const links = spyOn(fs, "readlinkSync").mockImplementation(
      refusing(link, denied, code),
    );
    try {
      const collector = new ProcessCollector(f.config, 100, 4096);
      const request = { time: 1000, uptime: 10, groups: [{ pids: [40] }] };
      const s = collector.read(request);
      const p = present(
        s.procs.find((p) => p.pid === 40),
        "scope main",
      );
      expect([p.cwd, p.executable, p.env, p.envAvailable]).toEqual([
        null,
        null,
        {},
        false,
      ]);
      expect(
        present(
          s.procs.find((p) => p.pid === 41),
          "launcher",
        ).executable,
      ).toBeNull();
      expect(s.processRead).toBe("complete");
      expect(s.errors.map((e) => e.source).sort()).toEqual(
        code === "EIO" ? [...details].sort() : [],
      );
      // A refused environment was not cached as an available empty one.
      text.mockRestore();
      links.mockRestore();
      const next = collector.read({ ...request, time: 2000 });
      expect(
        present(
          next.procs.find((p) => p.pid === 40),
          "readable main",
        ),
      ).toMatchObject({ envAvailable: true, cwd: f.root });
    } finally {
      text.mockRestore();
      links.mockRestore();
      f.cleanup();
    }
  },
);

test.each(["EACCES", "EPERM"])(
  "process detail permission exemptions do not cover other sources: %s",
  (code) => {
    const f = fixture();
    f.proc(40, "agents.slice/a.scope");
    const read = fs.readFileSync;
    try {
      for (const name of ["stat", "cgroup"]) {
        const path = join(f.config.procRoot, "40", name);
        const denied = spyOn(fs, "readFileSync").mockImplementation(
          refusing(read, new Set([path]), code),
        );
        try {
          const s = new ProcessCollector(f.config, 100, 4096).read({
            time: 1000,
            uptime: 10,
            groups: [],
          });
          expect(s.procs).toEqual([]);
          expect(s.errors.map((e) => e.source)).toEqual([
            join(f.config.procRoot, "40"),
          ]);
          expect(s.processRead).toBe("incomplete");
        } finally {
          denied.mockRestore();
        }
      }
      const denied = spyOn(fs, "readlinkSync").mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      try {
        const r = new Reader();
        const path = join(f.config.procRoot, "40/fd/3");
        expect(r.link(path)).toBeNull();
        expect(r.errors.map((e) => e.source)).toEqual([path]);
      } finally {
        denied.mockRestore();
      }
    } finally {
      f.cleanup();
    }
  },
);
