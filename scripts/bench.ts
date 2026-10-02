import { Collector } from "../src/collect/collector";
import { ProcessThread } from "../src/collect/process-thread";
import { shippedAgentTools } from "../src/config/agent-tools";
import { fixture } from "../src/test/fixture";
import { percentile } from "./percentile";

const measured = 20;
const spread = (values: number[]) => ({
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
});

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
  // The program's own arrangement: processes are read on their own thread.
  const collector = new Collector(
    f.config,
    100,
    4096,
    false,
    undefined,
    undefined,
    new ProcessThread(f.config, 100, 4096, shippedAgentTools),
  );
  const samples: number[] = [];
  const cpu: number[] = [];
  const phases: Record<string, number>[] = [];
  let firstMs = 0;
  try {
    for (let i = 0; i <= measured; i++) {
      const phase: Record<string, number> = {};
      // The whole process, so the process thread and the transfer count.
      const before = process.cpuUsage();
      const s = await collector.sample(1000 + i * 1000, (name, ms) => {
        phase[name] = ms;
      });
      const used = process.cpuUsage(before);
      if (s.errors.length) throw new Error(JSON.stringify(s.errors));
      if (
        s.procs.length !== 2000 ||
        s.groups.filter((g) => g.name.endsWith(".scope")).length !== 50 ||
        s.lanes.length !== 50
      )
        throw new Error("Benchmark did not collect its complete fixture");
      // The first sample starts the process thread, so it is reported alone.
      if (!i) firstMs = s.durationMs;
      else {
        samples.push(s.durationMs);
        cpu.push((used.user + used.system) / 1000);
        phases.push(phase);
      }
    }
  } finally {
    collector.close();
  }
  console.log(
    JSON.stringify({
      scopes: 50,
      processes: 2000,
      firstSampleMs: firstMs,
      samplesMs: samples,
      elapsedMs: spread(samples),
      cpuMs: spread(cpu),
      phaseMedianMs: Object.fromEntries(
        Object.keys(phases[0]).map((key) => [
          key,
          percentile(
            phases.map((p) => p[key]),
            0.5,
          ),
        ]),
      ),
      targetMs: 20,
      meetsTarget: samples.every((n) => n < 20),
    }),
  );
} finally {
  f.cleanup();
}
