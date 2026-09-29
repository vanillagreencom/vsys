import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  loadAgentToolNames,
  parseAgentToolsDocument,
  shippedAgentTools,
} from "./agent-tools";

const scratchRoots: string[] = [];
function scratch(name: string) {
  const root = join(process.cwd(), "tmp", `${name}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const shippedNames = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "opencode",
  "crush",
  "cursor-agent",
  "pi",
  "grok",
  "antigravity",
];
const ownerNames = ["dsh", "agy", "omp", "ori", "fx", "muse"];

test("agent tools parser accepts valid documents and rejects malformed rows", () => {
  // Control: relaxing a parser rule named in this table turns this test red.
  const valid = parseAgentToolsDocument(
    {
      version: 1,
      tools: [{ name: "zz-agent", mise: ["zz-install"] }],
      desktopExePrefixes: ["/zz/"],
      bundledCliSuffixes: ["/zz/cli"],
    },
    "valid-source.json",
  );
  expect(parseAgentToolsDocument(valid, "valid.json")).toEqual(valid);
  expect(
    parseAgentToolsDocument(
      JSON.parse(JSON.stringify({ ...valid, version: 1.0 })),
      "version-one-point-zero.json",
    ),
  ).toEqual(valid);
  const rows: [string, unknown][] = [
    ["bad version", { ...valid, version: 2 }],
    ["version true", { ...valid, version: true }],
    ["unknown document key", { ...valid, extra: true }],
    ["missing tools", { version: 1 }],
    ["bad name", { ...valid, tools: [{ name: "bad/name" }] }],
    ["bad mise", { ...valid, tools: [{ name: "ok", mise: ["bad/dir"] }] }],
    ["bad prefix", { ...valid, desktopExePrefixes: ["relative"] }],
    ["duplicate name", { ...valid, tools: [{ name: "a" }, { name: "a" }] }],
  ];
  for (const [name, value] of rows) {
    expect(() => parseAgentToolsDocument(value, `${name}.json`)).toThrow(
      `${name}.json`,
    );
  }
});

test("agent tools loader merges owner overlay after shipped defaults", async () => {
  expect(
    await loadAgentToolNames(
      join(process.cwd(), "data/owner-agent-tools.json"),
    ),
  ).toEqual([...shippedNames, ...ownerNames]);
});

test("agent tools loader uses shipped defaults when overlay is missing", async () => {
  const root = scratch("agent-tools-missing");
  expect(await loadAgentToolNames(join(root, "absent.json"))).toEqual(
    shippedNames,
  );
});

test("agent tools loader refuses malformed overlay and names the path", async () => {
  const root = scratch("agent-tools-bad");
  const path = join(root, "agent-tools.json");
  writeFileSync(path, "{");
  expect(loadAgentToolNames(path)).rejects.toThrow(path);
});

test("agent tool defaults match the shipped JSON file", () => {
  const fromFile = JSON.parse(
    readFileSync(join(process.cwd(), "data/agent-tools.json"), "utf8"),
  ).tools.map((tool: { name: string }) => tool.name);
  expect(fromFile.length).toBeGreaterThan(0);
  expect(shippedAgentTools.tools.map((tool) => tool.name)).toEqual(fromFile);
});

test("config sources do not keep an inline shipped tool list", () => {
  // Control: adding one quoted shipped tool name to a non-test source under
  // src/config turns this test red.
  const names = new Set(
    JSON.parse(
      readFileSync(join(process.cwd(), "data/agent-tools.json"), "utf8"),
    ).tools.map((tool: { name: string }) => tool.name),
  );
  expect(
    names.size,
    "extractor broke: data/agent-tools.json yielded no names",
  ).toBeGreaterThan(0);
  const hits: string[] = [];
  for (const entry of readdirSync(join(process.cwd(), "src/config"))) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
    const path = join(process.cwd(), "src/config", entry);
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/(["'`])([^"'`]+)\1/g)) {
      if (names.has(match[2])) hits.push(`${entry}: ${match[2]}`);
    }
  }
  expect(hits).toEqual([]);
});
