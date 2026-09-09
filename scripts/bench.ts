import { Collector } from "../src/collect/collector";
import { fixture } from "../src/test/fixture";

const f = fixture();
try {
  for (let scope = 0; scope < 50; scope++) {
    const name = `agents.slice/run-${scope}.scope`;
    const pids = Array.from({ length: 40 }, (_, i) => 100 + scope * 40 + i);
    f.group(name, pids);
    for (const pid of pids) {
      const comm = pids[0] === pid ? "claude" : "worker";
      f.proc(pid, name, {
        command: [`/usr/bin/${comm}`],
        comm,
        parent: pids[0] === pid ? 1 : pids[0],
      });
    }
  }
  const collector = new Collector(f.config, 100, 4096);
  const samples: number[] = [];
  const phases: Record<string, number>[] = [];
  for (let i = 0; i < 6; i++) {
    const phase: Record<string, number> = {};
    const s = await collector.sample(1000 + i * 1000, (name, ms) => {
      phase[name] = ms;
    });
    if (s.errors.length) throw new Error(JSON.stringify(s.errors));
    if (
      s.procs.length !== 2000 ||
      s.groups.filter((g) => g.name.endsWith(".scope")).length !== 50 ||
      s.lanes.length !== 50
    )
      throw new Error("Benchmark did not collect its complete fixture");
    if (i) {
      samples.push(s.durationMs);
      phases.push(phase);
    }
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      scopes: 50,
      processes: 2000,
      samplesMs: samples,
      medianMs: samples[Math.floor(samples.length / 2)],
      targetMs: 20,
      phaseMedianMs: Object.fromEntries(
        Object.keys(phases[0]).map((key) => [
          key,
          phases.map((p) => p[key]).sort((a, b) => a - b)[
            Math.floor(phases.length / 2)
          ],
        ]),
      ),
      meetsTarget: samples.every((n) => n < 20),
    }),
  );
} finally {
  f.cleanup();
}
