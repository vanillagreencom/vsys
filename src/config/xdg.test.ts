import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
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
