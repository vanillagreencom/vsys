import { useEffect, useState } from "react";
import { Reader } from "../collect/io";
import { scratchFiles } from "../collect/procs";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import { parentChain, processTree } from "../model/lanes";
import type { Lane, Snapshot } from "../model/types";
import type { History } from "../store/history";
import type { LaneSample } from "../store/lane-series";
import { laneBadge, laneLevel } from "./agents";
import { keyLabel } from "./chrome";
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
import { levelColor, scrollbar, ui } from "./theme";
import {
  Chart,
  Empty,
  Field,
  gutter,
  Heading,
  Line,
  Row,
  Tile,
  Tiles,
} from "./widgets";

/** The drill-down sections, closed until the reader opens one. */
const sections = ["Processes", "Launch", "Open files"] as const;
type Section = (typeof sections)[number];

/** One agent: what it is, what it uses, its history, then its processes. */
export function Agent({
  lane,
  snapshot,
  history,
  config: c,
  live,
  width,
  windowMs,
}: {
  lane: Lane;
  snapshot: Snapshot;
  history: History;
  config: Config;
  live: boolean;
  width: number;
  windowMs: number;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<{
    id: string;
    samples: LaneSample[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [section, setSection] = useState(0);
  const [open, setOpen] = useState<Set<Section>>(new Set());
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
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      setSection((i) => Math.min(sections.length - 1, i + 1));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setSection((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.open) {
      toggle(sections[section]);
      return true;
    }
    return false;
  });
  const toggle = (name: Section) =>
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
  const count = (name: Section) =>
    name === "Processes"
      ? tree.length
      : name === "Open files"
        ? unique.length
        : undefined;
  return (
    <scrollbox
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
          color={levelColor(level)}
        />
        <Chart
          title="Memory"
          values={rssPeaks}
          height={3}
          max={rssTop}
          top={bytes(rssTop, c)}
        />
        {(
          [
            ["CPU wait", "pressure"],
            ["Memory wait", "memoryPressure"],
            ["Disk wait", "ioPressure"],
          ] as const
        ).map(([label, key]) => (
          <Line key={key} height={1} flexShrink={0} truncate>
            <span attributes={ui.dim}>{label.padEnd(gutter)}</span>
            <span fg={ui.warn}>
              {sparkline(peaks(key), chartWidth, c.sparkline)}
            </span>
          </Line>
        ))}
        <Heading title="Details" />
        {sections.map((name, i) => (
          <box key={name} flexDirection="column" flexShrink={0}>
            <Row selected={section === i} onOpen={() => toggle(name)}>
              <span fg={ui.accent}>{open.has(name) ? "▾ " : "▸ "}</span>
              {name}
              {count(name) !== undefined && (
                <span attributes={ui.dim}>{`  ${count(name)}`}</span>
              )}
            </Row>
            {open.has(name) && (
              <box
                flexDirection="column"
                flexShrink={0}
                paddingLeft={3}
                paddingBottom={1}
              >
                {name === "Processes" && (
                  <>
                    <Line height={1} truncate attributes={ui.dim}>
                      {"PID      CPU    threads  memory     directory"}
                    </Line>
                    {tree.map(({ proc: p, depth }) => (
                      <Line key={p.pid} height={1} truncate>
                        {safe(
                          `${"  ".repeat(depth)}${String(p.pid).padEnd(8 - depth * 2)} ${p.comm.padEnd(14).slice(0, 14)} ${percent(p.cpuPercent).padStart(6)} ${String(p.threads).padStart(7)}  ${bytes(p.rss, c).padStart(9)}  ${p.cwd ?? gap}`,
                        )}
                      </Line>
                    ))}
                    {!tree.length && (
                      <Empty text="No process in this sample." />
                    )}
                  </>
                )}
                {name === "Launch" && (
                  <>
                    <Field label="Cgroup" value={proc?.group ?? lane.cgroup} />
                    <Field
                      label="Command"
                      value={proc?.command.join(" ") ?? gap}
                    />
                    <Field label="Executable" value={proc?.executable ?? gap} />
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
                    <Line height={1} truncate attributes={ui.dim} marginTop={1}>
                      Started by
                    </Line>
                    {proc &&
                      parentChain(proc, snapshot.procs).map((p) => (
                        <Line key={p.pid} height={1} truncate>
                          {safe(
                            `${String(p.pid).padEnd(8)} ${p.executable ?? gap}  ${p.command.join(" ")}`,
                          )}
                        </Line>
                      ))}
                  </>
                )}
                {name === "Open files" &&
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
              </box>
            )}
          </box>
        ))}
        <Line
          height={1}
          flexShrink={0}
          truncate
          attributes={ui.dim}
          marginTop={1}
        >
          {`${keyLabel(c.keys.open)} opens a section · ${keyLabel(c.keys.back)} back to the list`}
        </Line>
      </box>
    </scrollbox>
  );
}
