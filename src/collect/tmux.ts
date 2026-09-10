import { safe } from "../model/export";
import { shellLine } from "../model/shell";

/**
 * Where one pane sits in the tmux server. A pane id like `%9` is server-global
 * and says nothing about the window it belongs to, and two agents in the same
 * worktree are told apart by their window rather than by their pane.
 */
export interface PaneAddress {
  /** `session:window.pane`, the address a reader can type. */
  address: string;
  /** The window's name, which a reader recognises before its index. */
  window: string;
}
/**
 * Tabs separate the fields, not spaces: a session or a window may be named
 * with a space in it, and then a space-separated line cannot be split back
 * into the values it carried.
 */
export const paneFormat =
  "#{pane_id}\t#{session_name}:#{window_index}.#{pane_index}\t#{window_name}";
/** One read serves every lane, so the lines come back for the whole server. */
export const listPanesArgv = ["tmux", "list-panes", "-a", "-F", paneFormat];
export const capturePaneArgv = (paneId: string) => [
  "tmux",
  "capture-pane",
  "-p",
  "-t",
  paneId,
];
export const switchClientArgv = (paneId: string) => [
  "tmux",
  "switch-client",
  "-t",
  paneId,
];
/**
 * The line a reader copies when vsys cannot switch to the pane itself. This
 * one goes to a shell, so its target is quoted: a session named with a space
 * pastes as two words and runs against something else. The argv above is
 * handed to `Bun.spawn` as separate arguments and must not be quoted.
 */
export const switchCommand = (target: string) =>
  shellLine(switchClientArgv(target));

/**
 * A pane id, by tmux's own grammar: `%` and digits, nothing else. This decides
 * one thing: whether a handle can be looked up in a map keyed by `%N`. It does
 * not decide what tmux may be asked to do, because `-t` takes any target and
 * `session:window.pane` is one — refusing those refused input tmux accepts,
 * from readers who configured `VSYS_PANE` because the documentation says to.
 */
export const isPaneId = (value: string): boolean => /^%\d+$/.test(value);

/**
 * The addresses of every pane the server holds, keyed by pane id. A line that
 * does not carry all three fields is dropped rather than guessed at: a partial
 * address sends a reader to the wrong window.
 */
export function parsePanes(text: string): Map<string, PaneAddress> {
  const panes = new Map<string, PaneAddress>();
  for (const line of text.split("\n")) {
    const [id, address, window] = line.split("\t");
    if (!id || !address || window === undefined) continue;
    if (!isPaneId(id)) continue;
    panes.set(id, { address, window });
  }
  return panes;
}
/**
 * What a pane last drew, as lines a screen can print. The text is whatever the
 * agent's own program wrote, so it is treated as hostile: complete escape
 * sequences are dropped for legibility and `safe` then removes every control
 * byte that remains, which is what stops captured text moving the cursor,
 * repainting the screen or writing the clipboard.
 */
export function paneLines(text: string, limit = 200): string[] {
  const stripped = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: drop whole escape sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: drop whole escape sequences
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: drop whole escape sequences
    .replace(/\x1b[@-Z\\-_]/g, "");
  const lines = stripped.split("\n").map((line) => safe(line).trimEnd());
  while (lines.length && lines.at(-1) === "") lines.pop();
  return lines.slice(-limit);
}
/**
 * True when vsys is itself a client of a tmux server, which is what lets it
 * move the reader's view. `TMUX` is set by tmux inside every pane it owns, so
 * its presence is the question answered here; a vsys running outside tmux has
 * no client to move and offers the command as text instead.
 */
export const insideTmux = (env: Record<string, string | undefined>): boolean =>
  Boolean(env.TMUX);

/** A tmux read: the arguments, and what the server said if it refused. */
async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0)
    throw new Error(error.trim() || `${argv[0]} exited ${status}`);
  return out;
}
/**
 * Which tmux server this vsys talks to. tmux exports `TMUX` as
 * `socket,serverpid,session`, and the first two fields name the server: every
 * client of one server carries both alike, and only the session differs. The
 * path alone would call a server that died and restarted on the default
 * socket the same server, so a process still holding an old `%N` would have
 * it resolved against panes that are not its own. Empty when vsys is outside
 * tmux, which means the default socket rather than a known one.
 */
export const serverSocket = (): string => serverPart(process.env.TMUX);
/** The `socket,serverpid` of a `TMUX` value, and "" when there is none. */
export const serverPart = (tmux: string | null | undefined): string =>
  (tmux ?? "").split(",").slice(0, 2).join(",");
/** Every pane one server holds, and which server that was. */
export interface PaneSet {
  /** Empty when vsys is outside tmux, which is not the same as knowing. */
  socket: string;
  byId: Map<string, PaneAddress>;
}
/** Every pane the server holds, in one call however many lanes ask for one. */
export async function readPanes(): Promise<PaneSet> {
  return { socket: serverSocket(), byId: parsePanes(await run(listPanesArgv)) };
}
/** The last lines that pane drew. A pane that has gone away throws its reason. */
export async function capturePane(target: string): Promise<string[]> {
  if (!target) throw new Error("This agent exported no pane to read");
  return paneLines(await run(capturePaneArgv(target)));
}
