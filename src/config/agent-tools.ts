import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import shippedAgentToolsJson from "../../data/agent-tools.json";
import { writeFileAtomic } from "./atomic";

const documentKeys = new Set([
  "version",
  "tools",
  "desktopExePrefixes",
  "bundledCliSuffixes",
]);
const toolKeys = new Set(["name", "mise"]);
const toolNamePattern = /^\S+$/;
const miseDirPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export interface AgentToolEntry {
  name: string;
  mise: string[];
}

export interface AgentToolsDocument {
  version: 1;
  tools: AgentToolEntry[];
  desktopExePrefixes: string[];
  bundledCliSuffixes: string[];
}

export const agentToolsPath = join(homedir(), ".config/vsys/agent-tools.json");

function invalid(path: string, reason: string): never {
  throw new Error(`agent-tools invalid ${path}: ${reason}`);
}

function objectRecord(value: unknown, path: string, context: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(path, `${context} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  context: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) invalid(path, `${context} has unknown key ${unknown[0]}`);
}

function stringArray(
  value: unknown,
  path: string,
  context: string,
  valid: (item: string) => boolean,
  rule: string,
) {
  if (!Array.isArray(value)) invalid(path, `${context} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || !valid(item))
      invalid(path, `${context}[${index}] ${rule}`);
    return item;
  });
}

function rejectDuplicate(
  seen: Set<string>,
  value: string,
  path: string,
  context: string,
) {
  if (seen.has(value)) invalid(path, `${context} duplicates ${value}`);
  seen.add(value);
}

export function parseAgentToolsDocument(
  value: unknown,
  path = "agent-tools.json",
): AgentToolsDocument {
  const input = objectRecord(value, path, "document");
  rejectUnknownKeys(input, documentKeys, path, "document");
  if (input.version !== 1) invalid(path, "version must be 1");
  if (!Array.isArray(input.tools)) invalid(path, "tools must be an array");
  const names = new Set<string>();
  const miseDirs = new Set<string>();
  const tools = input.tools.map((rawTool, index) => {
    const tool = objectRecord(rawTool, path, `tools[${index}]`);
    rejectUnknownKeys(tool, toolKeys, path, `tools[${index}]`);
    if (
      typeof tool.name !== "string" ||
      tool.name.length === 0 ||
      !toolNamePattern.test(tool.name) ||
      tool.name.includes("/")
    )
      invalid(path, `tools[${index}].name is invalid`);
    rejectDuplicate(names, tool.name, path, "tool name");
    const mise =
      tool.mise === undefined
        ? []
        : stringArray(
            tool.mise,
            path,
            `tools[${index}].mise`,
            (item) => miseDirPattern.test(item),
            "must be a mise install directory name",
          );
    for (const dir of mise) rejectDuplicate(miseDirs, dir, path, "mise dir");
    return { name: tool.name, mise };
  });
  const desktopExePrefixes =
    input.desktopExePrefixes === undefined
      ? []
      : stringArray(
          input.desktopExePrefixes,
          path,
          "desktopExePrefixes",
          (item) => item.length > 0 && item.startsWith("/"),
          "must be a nonempty absolute path prefix",
        );
  const prefixSet = new Set<string>();
  for (const prefix of desktopExePrefixes)
    rejectDuplicate(prefixSet, prefix, path, "desktop exe prefix");
  const bundledCliSuffixes =
    input.bundledCliSuffixes === undefined
      ? []
      : stringArray(
          input.bundledCliSuffixes,
          path,
          "bundledCliSuffixes",
          (item) => item.length > 0 && item.startsWith("/"),
          "must be a nonempty absolute path suffix",
        );
  const suffixSet = new Set<string>();
  for (const suffix of bundledCliSuffixes)
    rejectDuplicate(suffixSet, suffix, path, "bundled cli suffix");
  return { version: 1, tools, desktopExePrefixes, bundledCliSuffixes };
}

export const shippedAgentTools = parseAgentToolsDocument(
  shippedAgentToolsJson,
  "data/agent-tools.json",
);

const emptyAgentToolsDocument = (): AgentToolsDocument => ({
  version: 1,
  tools: [],
  desktopExePrefixes: [],
  bundledCliSuffixes: [],
});

function mergeAgentTools(
  shipped: AgentToolsDocument,
  overlay: AgentToolsDocument,
  overlayPath: string,
): AgentToolsDocument {
  const merged: AgentToolsDocument = {
    version: 1,
    tools: [],
    desktopExePrefixes: [],
    bundledCliSuffixes: [],
  };
  const names = new Set<string>();
  const miseDirs = new Set<string>();
  const prefixes = new Set<string>();
  const suffixes = new Set<string>();
  for (const [document, path] of [
    [shipped, "data/agent-tools.json"],
    [overlay, overlayPath],
  ] as const) {
    for (const tool of document.tools) {
      rejectDuplicate(names, tool.name, path, "tool name");
      for (const dir of tool.mise)
        rejectDuplicate(miseDirs, dir, path, "mise dir");
      merged.tools.push({ name: tool.name, mise: [...tool.mise] });
    }
    for (const prefix of document.desktopExePrefixes) {
      rejectDuplicate(prefixes, prefix, path, "desktop exe prefix");
      merged.desktopExePrefixes.push(prefix);
    }
    for (const suffix of document.bundledCliSuffixes) {
      rejectDuplicate(suffixes, suffix, path, "bundled cli suffix");
      merged.bundledCliSuffixes.push(suffix);
    }
  }
  return merged;
}

async function loadOverlayDocument(
  overlayPath: string,
): Promise<AgentToolsDocument | null> {
  try {
    return parseAgentToolsDocument(
      JSON.parse(await readFile(overlayPath, "utf8")),
      overlayPath,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) invalid(overlayPath, error.message);
    throw error;
  }
}

export async function loadAgentToolNames(
  overlayPath = agentToolsPath,
): Promise<string[]> {
  const overlay = await loadOverlayDocument(overlayPath);
  if (!overlay) return shippedAgentTools.tools.map((tool) => tool.name);
  return mergeAgentTools(shippedAgentTools, overlay, overlayPath).tools.map(
    (tool) => tool.name,
  );
}

export interface AgentToolNamesSave {
  agentTools: string[];
  body: string | null;
}

/** Validate a Settings edit and build the overlay body without writing it. */
export async function prepareAgentToolNamesSave(
  names: string[],
  overlayPath = agentToolsPath,
): Promise<AgentToolNamesSave> {
  const shippedNames = new Set(
    shippedAgentTools.tools.map((tool) => tool.name),
  );
  const requestedNames = new Set(names);
  if (requestedNames.size !== names.length)
    throw new Error("Agent tool names contain duplicates");
  const missing = [...shippedNames].filter((name) => !requestedNames.has(name));
  if (missing.length)
    throw new Error(
      `Missing shipped agent tools: ${missing.join(", ")}. Shipped names cannot be removed because the shipped list is shared with the warden.`,
    );
  const existing = await loadOverlayDocument(overlayPath);
  if (existing) mergeAgentTools(shippedAgentTools, existing, overlayPath);
  const overlay = existing ?? emptyAgentToolsDocument();
  const existingTools = new Map(
    overlay.tools.map((tool) => [tool.name, tool] as const),
  );
  const nextOverlay = parseAgentToolsDocument(
    {
      version: 1,
      tools: names
        .filter((name) => !shippedNames.has(name))
        .map((name) => ({
          name,
          mise: [...(existingTools.get(name)?.mise ?? [])],
        })),
      desktopExePrefixes: [...overlay.desktopExePrefixes],
      bundledCliSuffixes: [...overlay.bundledCliSuffixes],
    },
    overlayPath,
  );
  const merged = mergeAgentTools(shippedAgentTools, nextOverlay, overlayPath);
  if (
    !existing &&
    nextOverlay.tools.length === 0 &&
    nextOverlay.desktopExePrefixes.length === 0 &&
    nextOverlay.bundledCliSuffixes.length === 0
  )
    return { agentTools: merged.tools.map((tool) => tool.name), body: null };
  return {
    agentTools: merged.tools.map((tool) => tool.name),
    body: `${JSON.stringify(nextOverlay, null, 2)}\n`,
  };
}

/** Persist a prepared overlay body. */
export async function writeAgentToolNamesSave(
  save: AgentToolNamesSave,
  overlayPath = agentToolsPath,
): Promise<void> {
  if (save.body === null) return;
  await writeFileAtomic(overlayPath, save.body);
}

/** Save Settings agent-program edits into the shared overlay. */
export async function saveAgentToolNames(
  names: string[],
  overlayPath = agentToolsPath,
): Promise<string[]> {
  const save = await prepareAgentToolNamesSave(names, overlayPath);
  await writeAgentToolNamesSave(save, overlayPath);
  return save.agentTools;
}
