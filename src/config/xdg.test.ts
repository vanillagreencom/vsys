import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { underHome } from "../test/fixture";
import { xdgHome } from "./xdg";

test("an XDG base directory is its variable when absolute, else the home default", () => {
  const rows: [
    string,
    Parameters<typeof xdgHome>[0],
    NodeJS.ProcessEnv,
    string,
  ][] = [
    [
      "config set",
      "XDG_CONFIG_HOME",
      { XDG_CONFIG_HOME: "/x/config" },
      "/x/config",
    ],
    ["config unset", "XDG_CONFIG_HOME", {}, join(homedir(), ".config")],
    [
      "config empty",
      "XDG_CONFIG_HOME",
      { XDG_CONFIG_HOME: "" },
      join(homedir(), ".config"),
    ],
    [
      "config relative",
      "XDG_CONFIG_HOME",
      { XDG_CONFIG_HOME: "x/config" },
      join(homedir(), ".config"),
    ],
    ["data set", "XDG_DATA_HOME", { XDG_DATA_HOME: "/x/data" }, "/x/data"],
    ["data unset", "XDG_DATA_HOME", {}, join(homedir(), ".local/share")],
    [
      "data empty",
      "XDG_DATA_HOME",
      { XDG_DATA_HOME: "" },
      join(homedir(), ".local/share"),
    ],
    [
      "data relative",
      "XDG_DATA_HOME",
      { XDG_DATA_HOME: "x/data" },
      join(homedir(), ".local/share"),
    ],
    ["state set", "XDG_STATE_HOME", { XDG_STATE_HOME: "/x/state" }, "/x/state"],
    ["state unset", "XDG_STATE_HOME", {}, join(homedir(), ".local/state")],
    [
      "state empty",
      "XDG_STATE_HOME",
      { XDG_STATE_HOME: "" },
      join(homedir(), ".local/state"),
    ],
    [
      "state relative",
      "XDG_STATE_HOME",
      { XDG_STATE_HOME: "x/state" },
      join(homedir(), ".local/state"),
    ],
    [
      "another variable set",
      "XDG_STATE_HOME",
      { XDG_CONFIG_HOME: "/x/config" },
      join(homedir(), ".local/state"),
    ],
  ];
  for (const [name, variable, env, dir] of rows)
    expect({ name, dir: xdgHome(variable, env) }).toEqual({ name, dir });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("a path only the home default holds stays there while the variable points elsewhere", async () => {
  const root = join(process.cwd(), "tmp", `xdg-path-${crypto.randomUUID()}`);
  roots.push(root);
  const home = join(root, "home");
  const moved = join(root, "moved");
  const legacy = join(home, ".config");
  for (const file of [
    join(legacy, "vsys/home-only"),
    join(legacy, "vsys/both"),
    join(moved, "vsys/both"),
    join(moved, "vsys/moved-only"),
    join(moved, "vsys/a-file"),
  ]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  const at = { XDG_CONFIG_HOME: moved };
  const rows: [string, NodeJS.ProcessEnv, string, string][] = [
    [
      "only the home default holds it",
      at,
      "vsys/home-only",
      join(legacy, "vsys/home-only"),
    ],
    ["both hold it", at, "vsys/both", join(moved, "vsys/both")],
    [
      "only the variable's directory holds it",
      at,
      "vsys/moved-only",
      join(moved, "vsys/moved-only"),
    ],
    ["neither holds it", at, "vsys/none", join(moved, "vsys/none")],
    ["variable unset", {}, "vsys/home-only", join(legacy, "vsys/home-only")],
    [
      "variable relative",
      { XDG_CONFIG_HOME: "x" },
      "vsys/none",
      join(legacy, "vsys/none"),
    ],
    [
      "the variable's path cannot be checked",
      at,
      "vsys/a-file/x",
      "error ENOTDIR",
    ],
  ];
  const resolved = await underHome(
    home,
    join(import.meta.dir, "xdg.ts"),
    `console.log(JSON.stringify(JSON.parse(process.env.VSYS_TEST_INPUT).map(([env, relative]) => {
  try {
    return subject.xdgPath("XDG_CONFIG_HOME", relative, env);
  } catch (e) {
    return \`error \${e.code}\`;
  }
})));`,
    rows.map(([, env, relative]) => [env, relative]),
  );
  expect(
    rows.map(([name], i) => ({ name, path: (resolved as string[])[i] })),
  ).toEqual(rows.map(([name, , , path]) => ({ name, path })));
});
