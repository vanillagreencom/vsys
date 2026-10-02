import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  loadAgentToolNames,
  loadAgentTools,
  parseAgentToolsDocument,
  saveAgentToolNames,
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
      tools: [{ name: "zz-agent", mise: ["zz-install"], paths: ["/zz/pkg/"] }],
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
  // The warden's parser reads the same table, so a rule pinned for one parser
  // is pinned for the other.
  const rows = JSON.parse(
    readFileSync(join(process.cwd(), "data/agent-tools-rejected.json"), "utf8"),
  ).rows as { name: string; document: unknown }[];
  expect(rows.length, "extractor broke: no rejected documents").toBeGreaterThan(
    0,
  );
  for (const { name, document } of rows) {
    expect(() => parseAgentToolsDocument(document, `${name}.json`)).toThrow(
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

test("an overlay entry naming a shipped tool adds to that tool's locations", async () => {
  const root = scratch("agent-tools-extend");
  const path = join(root, "agent-tools.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tools: [{ name: "codex", mise: ["codex-alt"], paths: ["/srv/codex/"] }],
    }),
  );
  const merged = await loadAgentTools(path);
  expect(merged.tools.map((tool) => tool.name)).toEqual(shippedNames);
  const codex = merged.tools.find((tool) => tool.name === "codex");
  expect(codex?.mise).toEqual(["codex", "codex-alt"]);
  expect(codex?.paths.at(-1)).toBe("/srv/codex/");
  // A location the shipped entry already names is refused, naming the overlay.
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tools: [{ name: "codex", paths: ["/.codex/packages/"] }],
    }),
  );
  await expect(loadAgentTools(path)).rejects.toThrow(path);
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

test("agent tools writer saves only overlay tools and preserves overlay signals", async () => {
  const root = scratch("agent-tools-save");
  const path = join(root, ".config/vsys/agent-tools.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: 1,
        tools: [
          {
            name: "local-agent",
            mise: ["local-agent"],
            paths: ["/opt/local/"],
          },
          { name: "removed-agent", mise: ["removed-agent"] },
          { name: "codex", mise: [], executables: ["/usr/local/bin/codex"] },
        ],
        desktopExePrefixes: ["/apps/"],
        bundledCliSuffixes: ["/bin/agent"],
      },
      null,
      2,
    )}\n`,
  );
  const names = [...shippedNames, "local-agent", "new-agent"];
  expect(await saveAgentToolNames(names, path)).toEqual(names);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    version: 1,
    tools: [
      { name: "codex", mise: [], executables: ["/usr/local/bin/codex"] },
      { name: "local-agent", mise: ["local-agent"], paths: ["/opt/local/"] },
      { name: "new-agent", mise: [] },
    ],
    desktopExePrefixes: ["/apps/"],
    bundledCliSuffixes: ["/bin/agent"],
  });
  expect(await loadAgentToolNames(path)).toEqual(names);
});

test("agent tools writer refuses removing shipped names before writing", async () => {
  const root = scratch("agent-tools-save-missing-shipped");
  const path = join(root, ".config/vsys/agent-tools.json");
  await expect(saveAgentToolNames(shippedNames.slice(1), path)).rejects.toThrow(
    "Shipped names cannot be removed",
  );
  await expect(loadAgentToolNames(path)).resolves.toEqual(shippedNames);
});

test("agent tools writer refuses malformed existing overlays", async () => {
  const root = scratch("agent-tools-save-bad-existing");
  const path = join(root, ".config/vsys/agent-tools.json");
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(
    {
      version: 1,
      tools: [{ name: "other-agent", mise: [shippedNames[0]] }],
      desktopExePrefixes: [],
      bundledCliSuffixes: [],
    },
    null,
    2,
  )}\n`;
  writeFileSync(path, body);
  await expect(
    saveAgentToolNames([...shippedNames, "new-agent"], path),
  ).rejects.toThrow(path);
  expect(readFileSync(path, "utf8")).toBe(body);
});

test("agent tool defaults match the shipped JSON file", () => {
  const fromFile = JSON.parse(
    readFileSync(join(process.cwd(), "data/agent-tools.json"), "utf8"),
  ).tools.map((tool: { name: string }) => tool.name);
  expect(fromFile.length).toBeGreaterThan(0);
  expect(shippedAgentTools.tools.map((tool) => tool.name)).toEqual(fromFile);
});

test("every shipped agent tool names where it is installed", () => {
  // Control: removing one shipped tool's paths and mise names turns this red.
  const tools = JSON.parse(
    readFileSync(join(process.cwd(), "data/agent-tools.json"), "utf8"),
  ).tools as { name: string; mise?: string[]; paths?: string[] }[];
  expect(
    tools.length,
    "extractor broke: data/agent-tools.json yielded no tools",
  ).toBeGreaterThan(0);
  expect(
    tools
      .filter((tool) => !tool.mise?.length && !tool.paths?.length)
      .map((tool) => tool.name),
  ).toEqual([]);
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
