// Driven by notify-stall.test.ts in a child Bun whose PATH starts with a stub
// notify-send: Bun resolves an executable against the PATH it started with.
// Prints the number of frames the session drew in four seconds, and the
// source errors the frames carried.
import { join } from "node:path";
import { defaults } from "../../src/config/config";
import type { Alert } from "../../src/model/types";
import { Session } from "../../src/runtime";
import { History } from "../../src/store/history";
import { emptySnapshot } from "../../src/test/fixture";

const dir = process.argv[2];
if (!dir) throw new Error("usage: notify-stall.driver.ts <scratch dir>");
const config = {
  ...defaults(),
  refreshMs: 100,
  persistence: false,
  notifications: ["unconfined"],
};
let time = 1000;
// Three escaped processes appear on each sample, as a build fanning out
// outside the agent slice does: each is a new "unconfined" alert.
const sample = async () => {
  time += 100;
  const s = emptySnapshot(time);
  s.alerts = [0, 1, 2].map(
    (i): Alert => ({
      time,
      rule: "unconfined",
      subject: `${time}:${i}`,
      message: `cc PID ${time + i} runs outside agents.slice`,
    }),
  );
  return s;
};
let frames = 0;
const sources = new Set<string>();
const session = new Session(
  config,
  () => join(dir, "config.toml"),
  { sample },
  new History(config),
  {
    frame: (s) => {
      frames++;
      for (const e of s.errors) sources.add(e.source);
    },
    error: (e) => {
      throw e;
    },
  },
  { agentToolsPath: join(dir, "agent-tools.json") },
);
session.start();
await Bun.sleep(4000);
session.stop();
console.log(JSON.stringify({ frames, errorSources: [...sources] }));
process.exit(0);
