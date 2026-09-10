import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { Reader } from "../collect/io";
import { scratchFiles } from "../collect/procs";
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
import { keyLabel } from "./chrome";
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
  sparkline,
} from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, metric, scrollbar, ui } from "./theme";
import {
  Chart,
  Empty,
  Field,
  gutter,
  Line,
  nextDown,
  Row,
  Section,
  Tile,
  Tiles,
} from "./widgets";

/** The drill-down sections, closed until the reader opens one. */
const sections = ["Processes", "Launch", "Open files", "Actions"] as const;
type SectionName = (typeof sections)[number];
/**
 * The selectable lines under Details. Actions sits last, so opening it adds
 * its rows below every section header and leaves the other rows where they
 * were.
 */
type DetailRow =
  | { kind: "section"; name: SectionName }
  | { kind: "action"; intent: LaneIntent };

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
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    scroller.current?.scrollChildIntoView(`detail-${selected}`);
  }, [selected]);
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
    ...sections.map((name) => ({ kind: "section", name }) as const),
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
      else if (row) onAct(row.intent);
      return true;
    }
    if (name === c.keys.copy) {
      const row = rows[selected];
      onCopy(row?.kind === "action" ? row.intent.text : undefined);
      return true;
    }
    return false;
  });
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
  const level = laneLevel(lane, c);
  const badge = laneBadge(lane);
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
      verticalScrollbarOptions={scrollbar}
      contentOptions={{ flexShrink: 0 }}
    >
      <box flexDirection="column" flexShrink={0} paddingX={2}>
        <Line height={1} flexShrink={0} truncate>
          <span attributes={ui.bold} fg={levelColor(level)}>
            {safe(lane.name)}
          </span>
          {badge && (
            <span fg={levelColor(badge.level)}>{`  ${badge.text}`}</span>
          )}
        </Line>
        <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
          {safe(
            [
              lane.tool || "no agent program",
              `account ${lane.account ?? gap}`,
              lane.pane ? `pane ${lane.pane}` : "",
              lane.title ? `window ${lane.title}` : "",
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
        <box height={1} flexShrink={0} />
        <Tiles>
          <Tile
            label="CPU"
            value={share(lane.cpu)}
            level={level}
            detail={`of one core · ${share(lane.cpuShare)} of the machine`}
          />
          <Tile
            label="Memory"
            value={amount(lane.rss, c)}
            level={lane.dangerous ? "danger" : "ok"}
            detail={`cache ${amount(lane.cache, c)} · swap ${amount(lane.swap, c)}`}
          />
          <Tile
            label="Disk written"
            value={rate(lane.writeRate, c)}
            detail={`read ${rate(lane.readRate, c)}`}
          />
          <Tile
            label="Tasks"
            value={String(lane.tasks)}
            level={lane.state === "blocked" ? "warn" : "ok"}
            detail={blockedText(lane)}
          />
        </Tiles>
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
          title={`CPU · last ${age(windowMs / 1000)}`}
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
            <span fg={color}>
              {sparkline(peaks(key), chartWidth, c.sparkline)}
            </span>
          </Line>
        ))}
        <Section title="Details" width={width - 4} />
        {rows.map((row, i) =>
          row.kind === "action" ? (
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
                <span fg={ui.accent}>{open.has(row.name) ? "▾ " : "▸ "}</span>
                {row.name}
                {count(row.name) !== undefined && (
                  <span attributes={ui.dim}>{`  ${count(row.name)}`}</span>
                )}
              </Row>
              {open.has(row.name) && (
                <box
                  flexDirection="column"
                  flexShrink={0}
                  paddingLeft={3}
                  paddingBottom={1}
                >
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
                </box>
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
