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

/** What tmux matches a pane on. The window matches by index or by name. */
interface PaneTarget {
  session: string;
  window: string;
  /** Empty when the target names a window and leaves the pane to tmux. */
  pane: string;
  /**
   * The pane component written as a handle, which tmux resolves without
   * reference to the window beside it: `vsys:other.%0` reaches `%0` though
   * `%0` sits in another window. Set only for that form.
   */
  handle?: string;
}
/** tmux's exact-match prefix. Every match below is exact, so it is dropped. */
const bare = (name: string): string => name.replace(/^=/, "");
/**
 * A handle in the digits tmux itself prints. `%007` and `%7` are one pane to
 * tmux, and the pane map is keyed by tmux's own output, which never pads. Two
 * spellings of one handle would otherwise compare unequal and a target naming
 * vsys's own pane would read as naming some other one.
 */
const canonHandle = (value: string): string => value.replace(/^%0+(?=\d)/, "%");
/**
 * A window part tmux reads as something other than a name: the relative forms
 * `+`, `-` and `!` with an optional offset, a braced form such as `{last}`,
 * and the characters tmux matches as a pattern. Each reaches a window this
 * parser cannot work out, and a window may also carry one of these as its
 * literal name, so matching the text would name the wrong window rather than
 * none. The exact-match prefix removes the ambiguity and is handled before
 * this is asked.
 */
const selector = (window: string): boolean =>
  /^[+-]\d*$/.test(window) ||
  window === "!" ||
  /^\{.*\}$/.test(window) ||
  /[*?[\]]/.test(window);
/**
 * Null when the target names no session: no address in the map carries one
 * either, and which session tmux would supply is not something the map says.
 */
function parseTarget(target: string): PaneTarget | null {
  const colon = target.indexOf(":");
  if (colon < 0) return null;
  const session = bare(target.slice(0, colon));
  const rest = target.slice(colon + 1);
  // The prefix is read before it is stripped, because it is what tells a
  // literal window name from a selector tmux would act on.
  const exact = rest.startsWith("=");
  const body = exact ? rest.slice(1) : rest;
  const dot = body.lastIndexOf(".");
  const tail = dot > 0 ? body.slice(dot + 1) : "";
  // The rest splits whenever it ends in a dot and digits, which is tmux's own
  // first reading: for `vsys:v1.2` both reach the pane in window `v1` where
  // that window and pane index exist. Where either is missing tmux resolves
  // something else — that window's active pane, or a window truly named
  // `v1.2` — and this parser matches nothing, so the answer is undecided.
  const split = dot > 0 && (/^\d+$/.test(tail) || isPaneId(tail));
  const window = split ? body.slice(0, dot) : body;
  // A handle in the pane component names its pane whatever window stands
  // beside it, so it is answered before the window is looked at.
  if (split && isPaneId(tail))
    return { session, window, pane: "", handle: canonHandle(tail) };
  if (!exact && selector(window)) return null;
  return { session, window, pane: split ? tail : "" };
}
function namesPane(target: PaneTarget, pane: PaneAddress): boolean {
  const at = parseTarget(pane.address);
  if (!at || at.pane === "") return false;
  return (
    target.session === at.session &&
    (target.window === at.window || target.window === pane.window) &&
    (target.pane === "" || target.pane === at.pane)
  );
}
/**
 * The panes a tmux target names, as `%N` handles. One pane answers to several
 * spellings: `vsys:2.1` is the address this map holds, `vsys:build.1` names
 * the window by its name, `vsys:2` leaves the pane to tmux, `vsys:build.%9`
 * puts the handle in the pane component, and a leading `=` forces the exact
 * match every comparison here already makes. A handle names itself, needs no
 * map, and is read in the digits tmux prints, so `%009` is `%9`.
 *
 * A set, because a target carrying no pane index names every pane of its
 * window and only the server knows which of them tmux would pick.
 *
 * Empty when the map cannot say: a target naming no session, a session or
 * window this map does not hold, a name tmux would match as a pattern or a
 * prefix, which is matched here as neither, or a window part tmux reads as a
 * selector rather than a name, such as a bare `+`, which may also be some
 * window's literal name.
 */
export function targetPanes(
  target: string,
  panes: Map<string, PaneAddress>,
): Set<string> {
  if (isPaneId(target)) return new Set([canonHandle(target)]);
  const parsed = parseTarget(target);
  if (!parsed) return new Set();
  if (parsed.handle) return new Set([parsed.handle]);
  const found = new Set<string>();
  for (const [id, pane] of panes) if (namesPane(parsed, pane)) found.add(id);
  return found;
}

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
/**
 * The pane vsys is drawing in, as the `%N` handle tmux exports into every pane
 * it owns. A lane holding this pane is vsys's own screen: capturing it draws
 * the screen inside itself, and switching to it moves a reader who is already
 * there. Empty outside tmux, where vsys occupies no pane.
 */
export const ownPane = (env: Record<string, string | undefined>): string =>
  env.TMUX_PANE ?? "";

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
export const serverSocket = (
  env: Record<string, string | undefined> = process.env,
): string => serverPart(env.TMUX);
/** The `socket,serverpid` of a `TMUX` value, and "" when there is none. */
export const serverPart = (tmux: string | null | undefined): string =>
  (tmux ?? "").split(",").slice(0, 2).join(",");
/** Every pane one server holds, which server that was, and which pane is ours. */
export interface PaneSet {
  /** Empty when vsys is outside tmux, which is not the same as knowing. */
  socket: string;
  /** The handle of the pane vsys draws in, empty when it draws in none. */
  own: string;
  byId: Map<string, PaneAddress>;
}
/**
 * The half of a `PaneSet` that comes from vsys's own environment rather than
 * from a server: which server vsys is attached to, and which pane it draws in.
 * Both stand whether or not a read answered, so the path that lost the read
 * builds them here rather than spelling the same two fields a second way.
 */
export const ownPaneSet = (
  env: Record<string, string | undefined> = process.env,
): PaneSet => ({
  socket: serverSocket(env),
  own: ownPane(env),
  byId: new Map(),
});
/** What a tmux read answers with, so a test can stand in for a server. */
export type Ask = (argv: string[]) => Promise<string>;
/**
 * Every pane the server holds, in one call however many lanes ask for one,
 * with the server and the pane vsys draws in read from the same environment.
 * The server and the environment are arguments so a test can assert what this
 * carries without a running tmux and without the machine's own panes.
 */
export async function readPanes(
  ask: Ask = run,
  env: Record<string, string | undefined> = process.env,
): Promise<PaneSet> {
  return { ...ownPaneSet(env), byId: parsePanes(await ask(listPanesArgv)) };
}
/** The last lines that pane drew. A pane that has gone away throws its reason. */
export async function capturePane(
  target: string,
  ask: Ask = run,
): Promise<string[]> {
  if (!target) throw new Error("This agent exported no pane to read");
  return paneLines(await ask(capturePaneArgv(target)));
}
