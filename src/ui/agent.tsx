import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { Reader } from "../collect/io";
import { scratchFiles } from "../collect/procs";
import { switchCommand } from "../collect/tmux";
import type { Config } from "../config/config";
import {
  type LaneIntent,
  laneActions,
  laneIntent,
  laneTarget,
} from "../model/actions";
import { safe } from "../model/export";
import { parentChain, processTree } from "../model/lanes";
import type { Lane, Snapshot } from "../model/types";
import type { History } from "../store/history";
import type { LaneSample } from "../store/lane-series";
import { laneBadge, laneLevel } from "./agents";
import { keyLabel, screenPad } from "./chrome";
import { fit } from "./columns";
import {
  age,
  amount,
  blockedText,
  bucketPeaks,
  bytes,
  capText,
  gap,
  percent,
  rate,
  share,
  spanLabel,
  sparkline,
} from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, metric, scrollbar, ui } from "./theme";
import {
  Chart,
  Detail,
  Disclosure,
  Empty,
  Field,
  gutter,
  Line,
  nextDown,
  Row,
  Section,
  Sparkline,
  Tile,
  Tiles,
  useKeepInView,
} from "./widgets";

/** The drill-down sections, closed until the reader opens one. */
/** How many captured lines the section shows: the tail is what is happening. */
const terminalLines = 12;
const sections = [
  "Processes",
  "Launch",
  "Terminal",
  "Open files",
  "Actions",
] as const;
type SectionName = (typeof sections)[number];
/**
 * The selectable lines under Details. Actions sits last, so opening it adds
 * its rows below every section header and leaves the other rows where they
 * were.
 */
type DetailRow =
  | { kind: "section"; name: SectionName }
  | { kind: "terminal" }
  | { kind: "action"; intent: LaneIntent };

/** Who an agent is: its name, its badge, its account and where it runs. */
export function AgentIdentity({
  lane,
  snapshot,
  config: c,
}: {
  lane: Lane;
  snapshot: Snapshot;
  config: Config;
}) {
  const proc = snapshot.procs.find((p) => p.pid === lane.mainPid);
  const badge = laneBadge(lane);
  return (
    <>
      <Line height={1} flexShrink={0} truncate>
        <span attributes={ui.bold} fg={levelColor(laneLevel(lane, c))}>
          {safe(lane.name)}
        </span>
        {badge && <span fg={levelColor(badge.level)}>{`  ${badge.text}`}</span>}
      </Line>
      <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
        {safe(
          [
            lane.tool || "no agent program",
            `account ${lane.account ?? gap}`,
            // The address is what a reader can act on; the raw `%N` is the
            // handle vsys acts through, and both are shown rather than one
            // standing in for the other.
            lane.address ? `pane ${lane.address}` : "",
            lane.address && lane.window ? `window ${lane.window}` : "",
            !lane.address && lane.pane ? `pane ${lane.pane}` : "",
            lane.title ? `title ${lane.title}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        )}
      </Line>
      <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
        {safe(
          `${lane.cwd || "no worktree"}${lane.branch ? `  ${lane.branch}` : ""}  ·  ${(proc?.group ?? lane.cgroup).split("/").filter(Boolean).at(-1) ?? lane.cgroup}  ·  PID ${lane.mainPid}  ·  up ${age(lane.age)}`,
        )}
      </Line>
    </>
  );
}
/** What one agent is using, as tiles. */
export function AgentTiles({
  lane,
  config: c,
  width,
}: {
  lane: Lane;
  config: Config;
  width?: number;
}) {
  return (
    <Tiles width={width}>
      <Tile
        key="CPU"
        label="CPU"
        value={share(lane.cpu)}
        level={laneLevel(lane, c)}
        detail={`of one core · ${share(lane.cpuShare)} of the machine`}
      />
      <Tile
        key="Memory"
        label="Memory"
        value={amount(lane.rss, c)}
        level={lane.dangerous ? "danger" : "ok"}
        detail={`cache ${amount(lane.cache, c)} · swap ${amount(lane.swap, c)}`}
      />
      <Tile
        key="Disk written"
        label="Disk written"
        value={rate(lane.writeRate, c)}
        detail={`read ${rate(lane.readRate, c)}`}
      />
      <Tile
        key="Tasks"
        label="Tasks"
        value={String(lane.tasks)}
        level={lane.state === "blocked" ? "warn" : "ok"}
        detail={blockedText(lane)}
      />
    </Tiles>
  );
}
/**
 * The selected agent beside the list, so the reader compares a row against
 * what it means without leaving the list.
 */
export function AgentSummary({
  lane,
  snapshot,
  config: c,
  width,
}: {
  lane: Lane;
  snapshot: Snapshot;
  config: Config;
  width: number;
}) {
  return (
    <box flexDirection="column" flexShrink={0} minWidth={0}>
      <Section title="Selected" width={width} marginTop={0} />
      <AgentIdentity lane={lane} snapshot={snapshot} config={c} />
      <box height={1} flexShrink={0} />
      <AgentTiles lane={lane} config={c} width={width} />
      <box height={1} flexShrink={0} />
      <Field
        label="Limits"
        value={`memory ${capText(lane, c)} · CPU weight ${lane.cpuWeight ?? gap}`}
        color={lane.dangerous ? ui.danger : undefined}
      />
      <Field
        label="Builds"
        value={`${
          Object.entries(lane.builds)
            .map(([kind, n]) => `${n} ${kind}`)
            .join(", ") || "none"
        } · ${lane.linkers} linking`}
      />
      <Line
        height={1}
        flexShrink={0}
        truncate
        attributes={ui.dim}
        marginTop={1}
      >
        {`${keyLabel(c.keys.open)} opens this agent`}
      </Line>
    </box>
  );
}
/** One agent: what it is, what it uses, its history, then its processes. */
export function Agent({
  lane,
  snapshot,
  history,
  config: c,
  live,
  width,
  windowMs,
  onCopy,
  onAct,
  onError,
  onCapture,
  onSwitch,
}: {
  lane: Lane;
  snapshot: Snapshot;
  history: History;
  config: Config;
  live: boolean;
  width: number;
  windowMs: number;
  /** Undefined when the selected row carries no command, which the shell says. */
  onCopy: (command: string | undefined) => void;
  /** Asks the shell for an action; the shell alone decides whether it runs. */
  onAct: (intent: LaneIntent) => void;
  /** Where a rejected read or switch reaches the reader, as a notice. */
  onError: (error: unknown) => void;
  /**
   * Reads what the agent's pane last drew. This changes nothing, so it is not
   * an action and does not wait on write mode.
   */
  onCapture?: (paneId: string) => Promise<string[]>;
  /**
   * Moves the reader's own tmux view to that pane. Present only when vsys is
   * itself a client of the server holding it; absent, the row hands over the
   * command as text instead. Moving a view touches no process either way.
   */
  onSwitch?: (paneId: string) => Promise<void>;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<{
    id: string;
    samples: LaneSample[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [open, setOpen] = useState<Set<SectionName>>(new Set());
  const [captured, setCaptured] = useState<
    { lines: string[] } | { error: string } | null
  >(null);
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  // The sections open and close and the pane fills asynchronously, so what sits
  // above the selected row moves without the selection moving.
  useKeepInView(scroller, `detail-${selected}`);
  const proc = snapshot.procs.find((p) => p.pid === lane.mainPid);
  const members = snapshot.procs.filter((p) => lane.pids.includes(p.pid));
  useEffect(() => {
    if (!live) {
      setFiles([]);
      return;
    }
    const reader = new Reader();
    const opened = scratchFiles(reader, c, lane.pids);
    setFiles([
      ...opened.map((f) => `${f.pid}: ${f.path}`),
      ...reader.errors.map((e) => `${e.source}: ${e.message}`),
    ]);
  }, [lane.pids, c, live]);
  const terminalOpen = open.has("Terminal");
  // A pane vsys could read: the lane has one, it belongs to the server vsys
  // talks to, and vsys settled it is not the pane it draws in, which is read
  // as the one answer permitting a read rather than the absence of `yes`,
  // since `unknown` is a pane vsys may be drawing in. One answer for the
  // effect below and for every message the section draws, the captured text
  // included, so a term added here can never close the messages while leaving
  // the read open. The text needs it because the effect clears it a commit
  // after the answer changes: raw, it draws under the refusal replacing it.
  const readable = Boolean(lane.pane) && !lane.elsewhere && lane.self === "no";
  const pane = readable && live ? captured : null;
  // The sample time is in the dependency list because it is the reason this
  // reads again: a terminal that only draws what it drew when the reader
  // opened it is not a terminal. The body has no other use for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the sample time is the clock
  useEffect(() => {
    if (!terminalOpen || !onCapture || !readable) {
      setCaptured(null);
      return;
    }
    let current = true;
    onCapture(lane.pane)
      .then((lines) => {
        if (current) setCaptured({ lines });
      })
      .catch((error: unknown) => {
        // A pane that has gone away says so in the server's own words, which
        // is a reader's only clue; an empty box would read as an idle agent.
        if (current)
          setCaptured({
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      current = false;
    };
  }, [terminalOpen, onCapture, readable, lane.pane, snapshot.time]);
  useEffect(() => {
    let current = true;
    setSeriesError(null);
    setLoading(true);
    void history
      .laneWindow(lane.id, snapshot.time, windowMs)
      .then((values) => {
        if (current) {
          setLoaded({ id: lane.id, samples: values });
          setLoading(false);
        }
      })
      .catch((error) => {
        if (current) {
          setSeriesError(String(error));
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [history, lane.id, snapshot.time, windowMs]);
  const target = laneTarget(lane, c);
  const rows: DetailRow[] = [
    ...sections.flatMap((name): DetailRow[] =>
      name === "Terminal" &&
      terminalOpen &&
      lane.pane &&
      live &&
      !lane.elsewhere
        ? [{ kind: "section", name }, { kind: "terminal" }]
        : [{ kind: "section", name }],
    ),
    ...(open.has("Actions") && target
      ? laneActions.map(
          (action) =>
            ({ kind: "action", intent: laneIntent(action, target) }) as const,
        )
      : []),
  ];
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      setSelected((i) => nextDown(rows.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setSelected((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.open) {
      const row = rows[selected];
      if (row?.kind === "section") toggle(row.name);
      else if (row?.kind === "terminal") goToTerminal();
      else if (row) onAct(row.intent);
      return true;
    }
    if (name === c.keys.copy) {
      const row = rows[selected];
      onCopy(
        row?.kind === "action"
          ? row.intent.text
          : // A switch to the pane the reader is in moves nothing, and one to
            // a pane that may be it is a move vsys cannot promise, so neither
            // gets a command to hand them.
            row?.kind === "terminal" && lane.self === "no"
            ? switchCommand(lane.pane)
            : undefined,
      );
      return true;
    }
    return false;
  });
  /**
   * One row, two answers. Inside the server that holds the pane vsys moves the
   * reader's own view; outside it there is no client to move, so the line goes
   * to the clipboard and the row says why. No terminal is ever launched: the
   * program that would open one differs on every desktop and does not exist on
   * macOS, while a switch behaves the same wherever tmux runs.
   */
  const goToTerminal = () => {
    // tmux moves a client to the pane it is already in by doing nothing, so
    // the row states that instead of asking for a move that cannot happen.
    // A pane vsys could not decide about is left alone for the same reason:
    // it may be that pane, and vsys cannot say which move it is asking for.
    if (lane.self !== "no") return;
    // A switch rejects when the pane has gone, the server stopped or the
    // target is not one it holds. Dropped, the reader pressed a key, nothing
    // moved, and nothing said why.
    if (onSwitch) void onSwitch(lane.pane).catch(onError);
    else onCopy(switchCommand(lane.pane));
  };
  const toggle = (name: SectionName) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const chartWidth = Math.max(10, width - 4 - gutter);
  const samples = loaded?.id === lane.id ? loaded.samples : [];
  const peaks = (key: Exclude<keyof LaneSample, "time">) =>
    bucketPeaks(
      samples,
      snapshot.time - windowMs,
      snapshot.time,
      chartWidth,
      (sample) => sample[key],
    );
  const cpuPeaks = peaks("cpu");
  const rssPeaks = peaks("rss");
  const top = (values: (number | null)[], floor: number) =>
    Math.max(floor, ...values.map((v) => v ?? 0));
  const cpuTop = top(cpuPeaks, 100);
  const rssTop = top(rssPeaks, 1);
  const kinds = Object.entries(lane.builds)
    .map(([kind, n]) => `${n} ${kind}`)
    .join(", ");
  const unique = [...new Set(files)];
  const tree = processTree(members);
  const count = (name: SectionName) =>
    name === "Processes"
      ? tree.length
      : name === "Open files"
        ? unique.length
        : undefined;
  return (
    <scrollbox
      ref={scroller}
      flexGrow={1}
      minHeight={0}
      scrollY
      scrollbarOptions={scrollbar}
      contentOptions={{ flexShrink: 0 }}
    >
      <box flexDirection="column" flexShrink={0} paddingX={screenPad}>
        <AgentIdentity lane={lane} snapshot={snapshot} config={c} />
        <box height={1} flexShrink={0} />
        <AgentTiles lane={lane} config={c} width={width - 4} />
        <box height={1} flexShrink={0} />
        <Field
          label="Limits"
          value={`memory ${capText(lane, c)} · CPU weight ${lane.cpuWeight ?? gap} · make jobs ${lane.jobs ?? "not set"} · jobserver ${lane.jobserver ?? "not set"}`}
          color={lane.dangerous ? ui.danger : undefined}
        />
        <Field
          label="Builds"
          value={`${kinds || "none"} · ${lane.linkers} linking · ${lane.sccache} sccache clients`}
        />
        <box height={1} flexShrink={0} />
        {seriesError && <Line fg={ui.danger}>{safe(seriesError)}</Line>}
        {loading && !samples.length && (
          <Line attributes={ui.dim}>Loading history</Line>
        )}
        <Chart
          title={`CPU · ${spanLabel(cpuPeaks, windowMs)}`}
          values={cpuPeaks}
          height={3}
          max={cpuTop}
          top={percent(cpuTop)}
          color={metric.cpu}
        />
        <Chart
          title="Memory"
          values={rssPeaks}
          height={3}
          max={rssTop}
          top={bytes(rssTop, c)}
          color={metric.memory}
        />
        {(
          [
            ["CPU wait", "pressure", metric.cpu],
            ["Memory wait", "memoryPressure", metric.memory],
            ["Disk wait", "ioPressure", metric.disk],
          ] as const
        ).map(([label, key, color]) => (
          <Line key={key} height={1} flexShrink={0} truncate>
            <span attributes={ui.dim}>{fit(label, gutter)}</span>
            <Sparkline
              marks={sparkline(peaks(key), chartWidth, c.sparkline)}
              color={color}
            />
          </Line>
        ))}
        <Section title="Details" width={width - 4} />
        {rows.map((row, i) =>
          row.kind === "terminal" ? (
            <box
              id={`detail-${i}`}
              key="go-to-terminal"
              flexShrink={0}
              paddingLeft={3}
            >
              <Row selected={selected === i} onOpen={goToTerminal}>
                {fit("Go to terminal", 16)}
                <span attributes={ui.dim}>
                  {safe(
                    lane.self === "yes"
                      ? "this is the terminal you are reading in"
                      : lane.self === "unknown"
                        ? "vsys cannot tell whether this is the terminal you are reading in"
                        : onSwitch
                          ? `moves this terminal to ${lane.address || lane.pane}`
                          : `vsys is not inside that tmux server · ${keyLabel(c.keys.open)} copies ${switchCommand(lane.pane)}`,
                  )}
                </span>
              </Row>
            </box>
          ) : row.kind === "action" ? (
            <box
              id={`detail-${i}`}
              key={row.intent.action}
              flexShrink={0}
              paddingLeft={3}
            >
              <Row
                selected={selected === i}
                onOpen={() => onAct(row.intent)}
                color={row.intent.action === "Stop" ? ui.danger : undefined}
              >
                {fit(row.intent.action, 8)}
                <span attributes={ui.dim}>{safe(row.intent.text)}</span>
              </Row>
            </box>
          ) : (
            <box
              id={`detail-${i}`}
              key={row.name}
              flexDirection="column"
              flexShrink={0}
            >
              <Row selected={selected === i} onOpen={() => toggle(row.name)}>
                <Disclosure
                  open={open.has(row.name)}
                  name={row.name}
                  count={count(row.name)}
                />
              </Row>
              {open.has(row.name) && (
                <Detail>
                  {row.name === "Processes" && (
                    <>
                      <Line height={1} truncate attributes={ui.dim}>
                        {"PID      CPU    threads  memory     directory"}
                      </Line>
                      {tree.map(({ proc: p, depth }) => (
                        <Line key={p.pid} height={1} truncate>
                          {safe(
                            `${"  ".repeat(depth)}${fit(String(p.pid), 8 - depth * 2)} ${fit(p.comm, 14)} ${percent(p.cpuPercent).padStart(6)} ${String(p.threads).padStart(7)}  ${bytes(p.rss, c).padStart(9)}  ${p.cwd ?? gap}`,
                          )}
                        </Line>
                      ))}
                      {!tree.length && (
                        <Empty text="No process in this sample." />
                      )}
                    </>
                  )}
                  {row.name === "Terminal" && (
                    <>
                      {!lane.pane && (
                        <Empty text="This agent exported no pane address, so vsys cannot find its terminal." />
                      )}
                      {/* `%9` is unique per tmux server, so the server this
                          vsys reads holds a `%9` of its own: reading or
                          switching would reach a stranger's pane. */}
                      {lane.pane && lane.elsewhere && (
                        <Empty text="This pane belongs to a different tmux server, which vsys is not talking to." />
                      )}
                      {/* Reading it would draw this screen inside itself, and
                          one copy deeper on every sample after that. Live
                          only: `self` was read when the sample was taken, and
                          the vsys that took an older one may have been drawing
                          somewhere else entirely. */}
                      {lane.self === "yes" && live && (
                        <Empty text="vsys is drawing in this pane, so what it holds is this screen." />
                      )}
                      {/* vsys could not compare this lane's address against
                          its own pane. Claiming it draws in this one would be
                          evidence vsys does not have, and reading it is the
                          mistake the whole section exists to avoid. */}
                      {lane.self === "unknown" && live && (
                        <Empty text="vsys cannot tell whether this pane is its own, so it is not reading it." />
                      )}
                      {/* A pane holds what it holds now, so reading one inside
                          a view of an older sample would put the present
                          inside the past. Said here rather than blamed on the
                          server, which is reachable. */}
                      {lane.pane && !lane.elsewhere && !live && (
                        <Empty text="A pane is read live; this is a past sample." />
                      )}
                      {readable && live && !onCapture && (
                        <Empty text="Reading a pane needs a tmux server this vsys can reach." />
                      )}
                      {readable && live && onCapture && pane === null && (
                        <Empty text="Reading the pane…" />
                      )}
                      {pane !== null && "error" in pane && (
                        <Empty
                          text={`This pane could not be read: ${safe(pane.error)}`}
                        />
                      )}
                      {pane !== null &&
                        "lines" in pane &&
                        (pane.lines.length ? (
                          pane.lines.slice(-terminalLines).map((line, at) => (
                            <Line
                              // biome-ignore lint/suspicious/noArrayIndexKey: a captured line is its position
                              key={`pane-${at}`}
                              height={1}
                              flexShrink={0}
                              truncate
                              attributes={ui.dim}
                            >
                              {safe(line)}
                            </Line>
                          ))
                        ) : (
                          <Empty text="This pane has drawn nothing." />
                        ))}
                    </>
                  )}
                  {row.name === "Launch" && (
                    <>
                      <Field
                        label="Cgroup"
                        value={proc?.group ?? lane.cgroup}
                      />
                      <Field
                        label="Command"
                        value={proc?.command.join(" ") ?? gap}
                      />
                      <Field
                        label="Executable"
                        value={proc?.executable ?? gap}
                      />
                      <Field
                        label="Environment"
                        value={
                          proc?.envAvailable === false
                            ? gap
                            : Object.entries(proc?.env ?? {})
                                .map(([k, v]) => `${k}=${v}`)
                                .join(" ") || "none of the watched variables"
                        }
                      />
                      <Line
                        height={1}
                        truncate
                        attributes={ui.dim}
                        marginTop={1}
                      >
                        Started by
                      </Line>
                      {proc &&
                        parentChain(proc, snapshot.procs).map((p) => (
                          <Line key={p.pid} height={1} truncate>
                            {safe(
                              `${fit(String(p.pid), 8)} ${p.executable ?? gap}  ${p.command.join(" ")}`,
                            )}
                          </Line>
                        ))}
                    </>
                  )}
                  {row.name === "Open files" &&
                    (live ? (
                      unique.length ? (
                        unique.map((file) => (
                          <Line key={file} height={1} truncate>
                            {safe(file)}
                          </Line>
                        ))
                      ) : (
                        <Empty text="No scratch file is open." />
                      )
                    ) : (
                      <Empty text="Open files are read live; this is a past sample." />
                    ))}
                  {row.name === "Actions" &&
                    (target === null ? (
                      <Empty text="This agent runs in no systemd scope vsys can address, so it has no actions." />
                    ) : (
                      <Line height={1} truncate attributes={ui.dim}>
                        {c.writeMode
                          ? `${keyLabel(c.keys.open)} runs the selected action after a confirmation`
                          : `Write mode is off · ${keyLabel(c.keys.copy)} copies the selected command`}
                      </Line>
                    ))}
                </Detail>
              )}
            </box>
          ),
        )}
        <Line
          height={1}
          flexShrink={0}
          truncate
          attributes={ui.dim}
          marginTop={1}
        >
          {`${keyLabel(c.keys.open)} opens a section · ${keyLabel(c.keys.copy)} copies a command · ${keyLabel(c.keys.back)} back to the list`}
        </Line>
      </box>
    </scrollbox>
  );
}
