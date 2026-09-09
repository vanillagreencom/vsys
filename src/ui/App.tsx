import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Reader } from "../collect/io";
import { scratchFiles } from "../collect/procs";
import { type Config, columns, validate } from "../config/config";
import {
  settingText as editText,
  settingValue as editValue,
} from "../config/editor";
import { keyName } from "../config/keys";
import { safe } from "../model/export";
import { dangerousCap, parentChain, processTree } from "../model/lanes";
import type { Lane, Snapshot } from "../model/types";
import type { History } from "../store/history";
import type { LaneSample } from "../store/lane-series";
import type { Point } from "../store/point";
import { Fleet } from "./Fleet";
import {
  age,
  amount,
  blockedText,
  bytes,
  capText,
  gap,
  percent,
  rate,
  share,
  sortLanes,
  sparkline,
  timeBuckets,
} from "./format";
import { type Attention, attention, Overview } from "./overview";
import { settingLabel } from "./settings";
import { themePalette } from "./theme";

const views = [
  "Overview",
  "Fleet",
  "Slices",
  "Builds",
  "Storage",
  "Timeline",
  "Alerts",
  "Settings",
] as const;
type View = (typeof views)[number] | "Lane";
/** A slow initial source cannot leave the terminal without a quit handler. */
export function Waiting({
  quitKey,
  onQuit,
}: {
  quitKey: string;
  onQuit: () => void;
}) {
  useKeyboard((key) => {
    const name = keyName(key);
    if (name === quitKey || name === "ctrl+c") onQuit();
  });
  return (
    <box flexDirection="column">
      <text>Collecting system data</text>
      <text>{`${quitKey} / ctrl+c quit`}</text>
    </box>
  );
}
const windows = [300000, 900000, 3600000, 21600000, 86400000];
export interface AppProps {
  snapshot: Snapshot;
  history: History;
  config: Config;
  onSave: (c: Config) => Promise<void>;
  onQuit: () => void;
  onExport: (s: Snapshot, format: "json" | "markdown") => Promise<string>;
}

/** Shared navigation keeps a historical Fleet pinned while live collection continues. */
export function App({
  snapshot,
  history,
  config: c,
  onSave,
  onQuit,
  onExport,
}: AppProps) {
  const [view, setView] = useState<View>("Overview");
  const [detailed, setDetailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  const [selected, setSelected] = useState(0);
  const [laneId, setLaneId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [pinned, setPinned] = useState<Snapshot | null>(null);
  const [windowIndex, setWindowIndex] = useState(0);
  const [message, setMessage] = useState("");
  const [columnMenu, setColumnMenu] = useState(false);
  const [settingIndex, setSettingIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const { width, height } = useTerminalDimensions();
  const palette = themePalette(c.theme);
  const shown = pinned ?? snapshot;
  const issues = attention(snapshot, c);
  const ordered = sortLanes(
    shown.lanes.filter((lane) =>
      [
        lane.name,
        lane.account ?? "",
        lane.pane,
        lane.title,
        lane.cwd,
        lane.branch,
        lane.tool,
      ].some((value) => value.toLowerCase().includes(query.toLowerCase())),
    ),
    c.sort,
    c.descending,
  );
  const selectedLane =
    shown.lanes.find((l) => l.id === laneId) ??
    ordered[Math.min(selected, ordered.length - 1)];
  const points = history.window(snapshot.time, windows[windowIndex]);
  const settings = [
    ...Object.keys(c).filter((k) => k !== "keys"),
    ...Object.keys(c.keys).map((k) => `keys.${k}`),
  ];
  const settingKey = settings[settingIndex];
  const settingValue = (key: string): unknown =>
    key.startsWith("keys.") ? c.keys[key.slice(5)] : c[key as keyof Config];
  const settingText = (key: string) => {
    const v = settingValue(key);
    return editText(v);
  };
  const report = (error: unknown) =>
    setMessage(error instanceof Error ? error.message : String(error));
  const save = (value: Config) => {
    try {
      void onSave(validate(value)).catch(report);
    } catch (error) {
      report(error);
    }
  };
  const navigate = (next: View) => {
    setView(next);
    setSelected(0);
    setColumnMenu(false);
    setSearching(false);
  };
  const openLane = (index: number) => {
    if (!ordered[index]) return;
    setSelected(index);
    setLaneId(ordered[index].id);
    setView("Lane");
  };
  const openAttention = (item: Attention) => {
    setPinned(null);
    if (item.laneId) {
      setLaneId(item.laneId);
      setView("Lane");
    } else navigate(item.view);
  };
  useEffect(() => {
    const length =
      view === "Overview"
        ? issues.length
        : columnMenu
          ? columns.length
          : ordered.length;
    setSelected((index) => Math.max(0, Math.min(index, length - 1)));
  }, [view, issues.length, ordered.length, columnMenu]);
  useEffect(() => {
    if (view === "Overview")
      scroller.current?.scrollChildIntoView(`attention-${selected}`);
  }, [view, selected]);
  const beginEdit = () => {
    setInput(settingText(settingKey));
    setEditing(true);
  };
  async function commitSetting(value: string) {
    try {
      const old = settingValue(settingKey);
      const parsed = editValue(old, value);
      const next = settingKey.startsWith("keys.")
        ? { ...c, keys: { ...c.keys, [settingKey.slice(5)]: parsed } }
        : { ...c, [settingKey]: parsed };
      await onSave(validate(next));
      setEditing(false);
      setMessage("Settings saved");
    } catch (e) {
      report(e);
    }
  }
  useKeyboard((key) => {
    const name = keyName(key);
    if (name === "ctrl+c") {
      onQuit();
      return;
    }
    if (searching) {
      if (name === "escape") {
        key.preventDefault();
        setSearching(false);
        setQuery("");
      }
      return;
    }
    if (editing) {
      if (name === "escape") {
        key.preventDefault();
        setEditing(false);
      }
      return;
    }
    if (name === c.keys.quit) {
      onQuit();
      return;
    }
    for (const v of views)
      if (name === c.keys[v.toLowerCase()]) {
        navigate(v);
        return;
      }
    if (name === c.keys.settings) {
      navigate("Settings");
      return;
    }
    if (name === c.keys.back) {
      setColumnMenu(false);
      navigate("Fleet");
      return;
    }
    if (
      (view === "Fleet" || view === "Settings" || view === "Overview") &&
      [c.keys.down, c.keys.up, "down", "up", c.keys.open].includes(name)
    )
      key.preventDefault();
    if (name === c.keys.exportJson || name === c.keys.exportMarkdown) {
      void onExport(shown, name === c.keys.exportJson ? "json" : "markdown")
        .then((path) => setMessage(`Export saved: ${path}`))
        .catch(report);
      return;
    }
    if (name === c.keys.pin) {
      if (pinned) {
        setPinned(null);
        setMessage("Fleet shows live data");
      } else {
        const at = history.at(cursor ?? snapshot.time);
        if (at) {
          setPinned(at);
          setMessage(`Fleet pinned: ${new Date(at.time).toLocaleTimeString()}`);
        } else setMessage("No retained snapshot at the cursor");
      }
    }
    if (name === c.keys.window) setWindowIndex((i) => (i + 1) % windows.length);
    if (view === "Overview") {
      if (name === c.keys.down || name === "down")
        setSelected((i) => Math.max(0, Math.min(issues.length - 1, i + 1)));
      if (name === c.keys.up || name === "up")
        setSelected((i) => Math.max(0, i - 1));
      if (name === c.keys.open && issues[selected])
        openAttention(issues[selected]);
    } else if (view === "Settings") {
      if (name === c.keys.down || name === "down")
        setSettingIndex((i) => Math.min(settings.length - 1, i + 1));
      if (name === c.keys.up || name === "up")
        setSettingIndex((i) => Math.max(0, i - 1));
      if (name === c.keys.open) beginEdit();
    } else if (view === "Fleet") {
      if (name === c.keys.search) {
        key.preventDefault();
        setSearching(true);
        setSelected(0);
      }
      if (name === c.keys.details) {
        setDetailed((v) => !v);
        setColumnMenu(false);
      }
      if (name === c.keys.down || name === "down")
        setSelected((i) =>
          Math.max(
            0,
            Math.min((columnMenu ? columns.length : ordered.length) - 1, i + 1),
          ),
        );
      if (name === c.keys.up || name === "up")
        setSelected((i) => Math.max(0, i - 1));
      if (name === c.keys.columns) {
        setDetailed(true);
        setColumnMenu((v) => !v);
        setSelected(0);
      }
      if (name === c.keys.sort)
        save({
          ...c,
          sort: columns[
            (columns.indexOf(c.sort as (typeof columns)[number]) + 1) %
              columns.length
          ],
        });
      if (name === c.keys.reverse) save({ ...c, descending: !c.descending });
      if (name === c.keys.open) {
        if (columnMenu) {
          const column = columns[selected];
          const next = c.columns.includes(column)
            ? c.columns.filter((v) => v !== column)
            : [...c.columns, column];
          if (next.length) save({ ...c, columns: next });
        } else if (ordered[selected]) {
          setLaneId(ordered[selected].id);
          setView("Lane");
        }
      }
    } else if (
      view === "Timeline" &&
      (name === c.keys.left ||
        name === c.keys.right ||
        name === "left" ||
        name === "right")
    ) {
      const index =
        cursor === null
          ? points.length - 1
          : Math.max(
              0,
              points.findLastIndex((p) => p.time <= cursor),
            );
      const next = Math.max(
        0,
        Math.min(
          points.length - 1,
          index + (name === c.keys.left || name === "left" ? -1 : 1),
        ),
      );
      setCursor(points[next]?.time ?? null);
      key.preventDefault();
    }
  });
  const line = (value: string, key: string | number = value) => (
    <text key={key} fg={palette.fg} flexShrink={0} wrapMode="word">
      {safe(value)}
    </text>
  );
  const limit = (v: number | null) =>
    v === null ? "max / unavailable" : bytes(v, c);
  let content: ReactNode;
  if (view === "Overview")
    content = (
      <Overview
        snapshot={snapshot}
        config={c}
        items={issues}
        selected={selected}
        onOpen={openAttention}
      />
    );
  else if (view === "Fleet") {
    content = columnMenu ? (
      <box flexDirection="column">
        {columns.map((column, i) => (
          <text
            key={column}
            height={1}
            flexShrink={0}
            truncate
            bg={selected === i ? palette.selected : undefined}
            fg={palette.fg}
            attributes={selected === i ? palette.selection : undefined}
            onMouseDown={() => {
              setSelected(i);
              const next = c.columns.includes(column)
                ? c.columns.filter((v) => v !== column)
                : [...c.columns, column];
              if (next.length) save({ ...c, columns: next });
            }}
          >{`${c.columns.includes(column) ? "[x]" : "[ ]"} ${column}`}</text>
        ))}
      </box>
    ) : (
      <>
        <text height={1} flexShrink={0} truncate fg={palette.fg}>
          {safe(
            `Fleet ${pinned ? `PINNED ${new Date(shown.time).toLocaleTimeString()}` : "LIVE"} | ${query ? `Filter: ${query}` : `${c.keys.search} find lane, account or worktree`}`,
          )}
        </text>
        {searching && (
          <box
            height={3}
            flexShrink={0}
            border
            borderColor={palette.fg}
            title="Find a lane: Enter applies, Esc clears"
          >
            <input
              focused
              value={query}
              onInput={setQuery}
              onSubmit={() => setSearching(false)}
            />
          </box>
        )}
        <Fleet
          lanes={ordered}
          config={c}
          selected={selected}
          width={width - 18}
          height={height - 7 - (searching ? 3 : 0)}
          detailed={detailed}
          onOpen={openLane}
          onSort={(column) =>
            save({
              ...c,
              sort: column,
              descending: c.sort === column ? !c.descending : true,
            })
          }
        />
      </>
    );
  } else if (view === "Slices")
    content = (
      <>
        {line(
          "Slices: CPU weight / quota; memory current / high / max; swap current / max; tasks current / max",
        )}
        {shown.groups.map((g) => {
          const siblings = shown.groups.filter(
            (s) => s.parent === g.parent && s.path !== ".",
          );
          const weightSum = siblings.reduce((n, s) => n + (s.weight ?? 0), 0);
          return (
            <box key={g.path} flexDirection="column">
              <text
                fg={
                  dangerousCap(g, shown.groups, c.memoryFloor) ||
                  shown.lanes.some((l) => l.id === g.path && l.unconfined)
                    ? palette.danger
                    : palette.fg
                }
              >{`${"  ".repeat(g.path.split("/").length - 1)}${safe(g.name)} | CPU ${percent(g.cpuPercent)} weight ${g.weight ?? "?"} share ${weightSum && g.weight !== null ? percent((g.weight / weightSum) * 100) : "?"} quota ${g.cpuMax ?? "?"}`}</text>
              {line(
                `  Memory ${bytes(g.memory, c)} / ${limit(g.high)} / ${limit(g.max)} | swap ${bytes(g.swap, c)} / ${limit(g.swapMax)} | tasks ${g.tasks ?? "?"} / ${g.tasksMax ?? "max / unavailable"}`,
              )}
              {line(
                `  Pressure ${Object.entries(g.pressure)
                  .map(([kind, p]) => `${kind} ${percent(p?.some)}`)
                  .join(" | ")}`,
              )}
            </box>
          );
        })}
        {line(
          "CPU share applies among runnable siblings under contention. Parent limits also apply.",
        )}
        {line(
          `System swap ${bytes(shown.system.memory.SwapTotal, c)} total / ${bytes(shown.system.memory.SwapFree, c)} free`,
        )}
        {shown.system.zram.map((z) =>
          line(
            `${z.device}: original ${bytes(z.original, c)}, compressed ${bytes(z.compressed, c)}, used ${bytes(z.used, c)}`,
            z.device,
          ),
        )}
      </>
    );
  else if (view === "Builds") {
    const builds = shown.procs
      .filter((p) => p.build)
      .sort((a, b) => a.group.localeCompare(b.group) || a.pid - b.pid);
    content = (
      <>
        {line(
          `Build processes ${builds.length} | threads ${builds.reduce((n, p) => n + p.threads, 0)} | CPU cores ${shown.system.cores}`,
        )}
        {builds.map((p, i) => (
          <box key={p.pid} flexDirection="column">
            {(i === 0 || builds[i - 1].group !== p.group) && line(p.group)}
            {line(
              `  ${p.pid} ${p.build} | ${p.threads} threads | ${bytes(p.rss, c)} | ${percent(p.cpuPercent)} | ${age(p.age)} | ${p.cwd ?? "?"}`,
            )}
          </box>
        ))}
        {!builds.length && line("No build processes in this sample")}
      </>
    );
  } else if (view === "Storage")
    content = (
      <>
        {shown.storage.mountsAvailable === false
          ? line("Mount information unavailable")
          : !shown.storage.volumes.length && line("No watched btrfs mounts")}
        {shown.storage.volumes.map((v) => (
          <box key={v.mount} flexDirection="column">
            <text fg={v.readOnly ? palette.danger : palette.fg}>
              {safe(
                `${v.mount} | ${v.device} | ${v.readOnly ? "READ ONLY" : "read-write"} | ${bytes(v.free, c)} free / ${bytes(v.total, c)}`,
              )}
            </text>
            {line(v.options.join(", "))}
            {v.countersAvailable === false &&
              line("Device counters unavailable")}
            {Object.entries(v.errors).map(([kind, value]) =>
              line(
                `  ${kind}: ${value} | last +${v.delta[kind]} | since start +${v.sinceStart[kind]}`,
                kind,
              ),
            )}
          </box>
        ))}
        {line("Scrub results")}
        {shown.storage.scrubs.map((s) => (
          <text
            key={s.path}
            fg={s.problem ? palette.danger : palette.fg}
          >{`${safe(s.path)}\n${safe(s.text)}`}</text>
        ))}
        {line(
          `Scratch directories and sessions | ${shown.storage.scratchPending ? "scanning" : "idle"} | ${shown.storage.scratchTime === null ? "no completed sample" : new Date(shown.storage.scratchTime ?? shown.time).toLocaleTimeString()}`,
        )}
        {[...shown.storage.scratch, ...shown.storage.sessions].map((s) =>
          line(
            `${s.path} | ${bytes(s.bytes, c)} | modified ${age(s.modifiedAt == null ? s.age : Math.max(0, (shown.time - s.modifiedAt) / 1000))} ago${s.error ? ` | ${s.error}` : ""}`,
            s.path,
          ),
        )}
      </>
    );
  else if (view === "Timeline") {
    const at = cursor ?? points.at(-1)?.time;
    const selectedPoint = points.findLast(
      (p) => at !== undefined && p.time <= at,
    );
    const start = snapshot.time - windows[windowIndex];
    const chartWidth = Math.max(1, width - 20);
    const buckets = timeBuckets(points, start, snapshot.time, chartWidth);
    const cursorIndex =
      at === undefined
        ? -1
        : Math.min(
            chartWidth - 1,
            Math.max(
              0,
              Math.floor(((at - start) * chartWidth) / windows[windowIndex]),
            ),
          );
    const series: [keyof Point, string][] = [
      ["agents", "Agents CPU %"],
      ["desktop", "Desktop CPU %"],
      ["memory", "Memory"],
      ["pressure", "CPU pressure %"],
      ["memoryPressure", "Memory pressure %"],
      ["ioPressure", "IO pressure %"],
      ["corruption", "Btrfs corruption"],
      ["unconfined", "Unconfined agents"],
      ["builds", "Build processes"],
    ];
    content = (
      <>
        {line(
          `Timeline | window ${age(windows[windowIndex] / 1000)} | cursor ${at === undefined ? "no samples" : new Date(at).toLocaleString()} | sample ${selectedPoint ? new Date(selectedPoint.time).toLocaleTimeString() : "none"}`,
        )}
        {series.map(([key, label]) => (
          <box key={key} flexDirection="column">
            {line(
              `${label}: ${selectedPoint ? (key === "memory" ? bytes(selectedPoint.memory, c) : String(selectedPoint[key] ?? "?")) : "?"}`,
            )}
            <text
              fg={palette.fg}
              onMouseDown={(event) => {
                if (!event.currentTarget) return;
                const column = Math.max(
                  0,
                  Math.min(
                    chartWidth - 1,
                    Math.floor(event.x - event.currentTarget.x),
                  ),
                );
                setCursor(
                  buckets[column].at(-1)?.time ??
                    start + (column * windows[windowIndex]) / chartWidth,
                );
              }}
            >
              {sparkline(
                buckets.map((bucket) => {
                  let peak: number | null = null;
                  for (const point of bucket) {
                    const value = point[key];
                    if (typeof value === "number" && Number.isFinite(value))
                      peak = peak === null ? value : Math.max(peak, value);
                  }
                  return peak;
                }),
                chartWidth,
                c.sparkline,
              )}
            </text>
          </box>
        ))}
        {line(
          buckets
            .map((bucket, i) =>
              bucket.some((p) => p.alerts.length)
                ? "!"
                : i === cursorIndex
                  ? "│"
                  : "·",
            )
            .join(""),
        )}
        {line(
          `${new Date(start).toLocaleTimeString()} to ${new Date(snapshot.time).toLocaleTimeString()} | ! alert | │ cursor | · no sample`,
        )}
        {points
          .flatMap((p) => p.alerts)
          .map((a, i) =>
            line(`${new Date(a.time).toLocaleTimeString()} ! ${a.message}`, i),
          )}
      </>
    );
  } else if (view === "Alerts")
    content = (
      <>
        {history
          .alerts(snapshot.time)
          .slice()
          .reverse()
          .map((a, i) =>
            line(
              `${new Date(a.time).toLocaleString()} | ${a.rule} | ${a.message}`,
              i,
            ),
          )}
        {!history.alerts(snapshot.time).length &&
          line("No rule hits in retained history")}
        {line("Source errors")}
        {shown.errors.map((e, i) => line(`${e.source}: ${e.message}`, i))}
      </>
    );
  else if (view === "Settings") {
    const start = Math.max(0, settingIndex - Math.floor((height - 10) / 2));
    content = (
      <>
        {line(
          `Settings | ${c.keys.open} edits | return saves | escape cancels | lists: ["a", "b"]`,
        )}
        {settings
          .slice(start, start + Math.max(1, height - 10))
          .map((key, i) => (
            <text
              key={key}
              height={1}
              flexShrink={0}
              truncate
              bg={settingIndex === start + i ? palette.selected : undefined}
              fg={palette.fg}
              attributes={
                settingIndex === start + i ? palette.selection : undefined
              }
              onMouseDown={() => {
                setSettingIndex(start + i);
                setInput(settingText(key));
                setEditing(true);
              }}
            >
              {safe(`${settingLabel(key)}: ${settingText(key)}`)}
            </text>
          ))}
        {editing && (
          <box
            border
            borderColor={palette.fg}
            height={3}
            flexShrink={0}
            title={settingLabel(settingKey)}
          >
            <input
              focused
              value={input}
              onInput={setInput}
              onSubmit={() => {
                void commitSetting(input);
              }}
            />
          </box>
        )}
      </>
    );
  } else
    content = selectedLane ? (
      <LaneDetail
        lane={selectedLane}
        snapshot={shown}
        history={history}
        config={c}
        live={!pinned}
        width={width - 20}
        windowMs={windows[windowIndex]}
      />
    ) : (
      line("Lane no longer exists in this sample")
    );
  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={palette.bg}
    >
      <text fg={palette.fg} height={1} flexShrink={0} truncate>
        {safe(
          `vsys-view | ${snapshot.system.host} | ${pinned && ["Fleet", "Lane", "Slices", "Builds", "Storage"].includes(view) ? "PINNED" : "LIVE"} | ${new Date(snapshot.time).toLocaleTimeString()} | read-only monitor`,
        )}
      </text>
      <box flexDirection="row" flexGrow={1} minHeight={0} minWidth={0}>
        <box
          width={15}
          flexShrink={0}
          flexDirection="column"
          border
          borderColor={palette.fg}
        >
          {views.map((v) => (
            <text
              key={v}
              height={1}
              flexShrink={0}
              truncate
              bg={view === v ? palette.selected : undefined}
              fg={palette.fg}
              attributes={view === v ? palette.selection : undefined}
              onMouseDown={() => navigate(v)}
            >{`${c.keys[v.toLowerCase()] ?? c.keys.settings} ${v}`}</text>
          ))}
        </box>
        <scrollbox
          id="view-scroll"
          key={`${view}-${columnMenu}-${detailed}`}
          ref={scroller}
          flexGrow={1}
          minWidth={0}
          minHeight={0}
          focused={!editing && !searching}
          scrollX={view === "Fleet" && detailed}
          scrollY
          contentOptions={{ flexShrink: 0 }}
        >
          <box flexDirection="column" flexShrink={0} paddingX={1}>
            {pinned &&
              ["Fleet", "Lane", "Slices", "Builds", "Storage"].includes(view) &&
              line(`PINNED snapshot ${new Date(shown.time).toLocaleString()}`)}
            {content}
          </box>
        </scrollbox>
      </box>
      <text fg={palette.warning} height={1} flexShrink={0} truncate>
        {safe(
          message ||
            history.retentionWarning ||
            (snapshot.errors.length
              ? `Partial data: ${snapshot.errors.length} source reads unavailable. ${c.keys.alerts} Alerts shows details.`
              : `${issues.length ? `${issues.length} current concerns` : "No current concerns detected"} | Sample ${snapshot.durationMs.toFixed(1)} ms`),
        )}
      </text>
      <text
        fg={palette.fg}
        height={1}
        flexShrink={0}
        truncate
      >{`${c.keys.quit} quit | ${c.keys.overview} overview | ${view === "Fleet" ? `up/down select | Enter detail | ${c.keys.search} find | ${c.keys.details} table` : view === "Timeline" ? `left/right time | ${c.keys.window} window | ${c.keys.pin} pin Fleet` : view === "Settings" ? "up/down select | Enter edit | Esc cancel" : view === "Overview" ? "up/down choose concern | Enter inspect" : `arrows scroll | Esc Fleet | ${c.keys.exportJson}/${c.keys.exportMarkdown} export`}`}</text>
    </box>
  );
}

function LaneDetail({
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
  const palette = themePalette(c.theme);
  const [loaded, setLoaded] = useState<{
    id: string;
    samples: LaneSample[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const proc = snapshot.procs.find((p) => p.pid === lane.mainPid);
  const members = snapshot.procs.filter((p) => lane.pids.includes(p.pid));
  const kinds = Object.entries(lane.builds)
    .map(([kind, n]) => `${kind} ${n}`)
    .join(", ");
  useEffect(() => {
    if (!live) {
      setFiles(["Open file descriptors are available for live lanes"]);
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
  const buckets = timeBuckets(
    loaded?.id === lane.id ? loaded.samples : [],
    snapshot.time - windowMs,
    snapshot.time,
    Math.max(1, width),
  );
  const chart = (key: Exclude<keyof LaneSample, "time">) =>
    sparkline(
      buckets.map((bucket) => {
        let peak: number | null = null;
        for (const sample of bucket) {
          const value = sample[key];
          if (value !== null)
            peak = peak === null ? value : Math.max(peak, value);
        }
        return peak;
      }),
      Math.max(1, width),
      c.sparkline,
    );
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={palette.fg}>
        {safe(
          `${lane.name} | ${proc?.group ?? lane.cgroup} | main PID ${lane.mainPid}`,
        )}
      </text>
      <text fg={palette.fg} flexShrink={0} wrapMode="word">
        {safe(
          `Account: ${lane.account ?? gap} | Agent: ${lane.tool || gap} | Pane: ${lane.pane || gap} | Window: ${lane.title || gap}`,
        )}
      </text>
      <text fg={palette.fg} flexShrink={0} wrapMode="word">
        {safe(`Worktree: ${lane.cwd || gap} | Branch: ${lane.branch || gap}`)}
      </text>
      <text
        fg={palette.fg}
        flexShrink={0}
        wrapMode="word"
      >{`CPU ${share(lane.cpu)} of one core, ${share(lane.cpuShare)} of the machine | Tasks ${lane.tasks}`}</text>
      <text
        fg={palette.fg}
        flexShrink={0}
        wrapMode="word"
      >{`Memory ${amount(lane.rss, c)} | Page cache ${amount(lane.cache, c)} | Swap ${amount(lane.swap, c)}`}</text>
      <text
        fg={palette.fg}
        flexShrink={0}
        wrapMode="word"
      >{`Disk: read ${rate(lane.readRate, c)} | written ${rate(lane.writeRate, c)}`}</text>
      <text fg={palette.fg} flexShrink={0} wrapMode="word">
        {safe(
          `Build work: ${kinds || "none"} | ${lane.linkers} linking | sccache clients ${lane.sccache}`,
        )}
      </text>
      <text
        fg={lane.dangerous ? palette.danger : palette.fg}
        flexShrink={0}
        wrapMode="word"
      >
        {safe(
          `Caps: memory.max ${capText(lane, c)} | cpu.weight ${lane.cpuWeight ?? gap} | make jobs ${lane.jobs ?? "not set"} | jobserver ${lane.jobserver ?? "not set"}${lane.unconfined ? " | Outside agent slice" : ""}`,
        )}
      </text>
      <text
        fg={lane.state === "blocked" ? palette.warning : palette.fg}
        flexShrink={0}
        wrapMode="word"
      >
        {safe(`State: ${blockedText(lane)}`)}
      </text>
      {seriesError && <text fg={palette.danger}>{safe(seriesError)}</text>}
      {loading && <text fg={palette.fg}>Loading lane history</text>}
      <text fg={palette.fg}>{`CPU ${chart("cpu")}`}</text>
      <text fg={palette.fg}>{`RSS ${chart("rss")}`}</text>
      <text fg={palette.fg}>{`CPU pressure ${chart("pressure")}`}</text>
      <text
        fg={palette.fg}
      >{`Memory pressure ${chart("memoryPressure")}`}</text>
      <text fg={palette.fg}>{`IO pressure ${chart("ioPressure")}`}</text>
      <text fg={palette.fg} flexShrink={0}>
        Launch and process details
      </text>
      <text fg={palette.fg}>
        {safe(`Launch: ${proc?.command.join(" ") ?? "?"}`)}
      </text>
      <text fg={palette.fg}>
        {safe(`Executable: ${proc?.executable ?? "?"}`)}
      </text>
      <text fg={palette.fg}>
        {safe(
          `Environment${proc?.envAvailable === false ? " unavailable" : ""}: ${Object.entries(
            proc?.env ?? {},
          )
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")}`,
        )}
      </text>
      <text fg={palette.fg}>Parent chain</text>
      {proc &&
        parentChain(proc, snapshot.procs).map((p) => (
          <text key={p.pid} fg={palette.fg}>
            {safe(`${p.pid} ${p.executable ?? "?"} | ${p.command.join(" ")}`)}
          </text>
        ))}
      <text fg={palette.fg}>
        Process tree: PID command | CPU | threads | RSS | cwd
      </text>
      {processTree(members).map(({ proc: p, depth }) => (
        <text key={p.pid} fg={palette.fg}>
          {safe(
            `${"  ".repeat(depth)}${p.pid} ${p.comm} | ${percent(p.cpuPercent)} | ${p.threads} | ${bytes(p.rss, c)} | ${p.cwd ?? "?"}`,
          )}
        </text>
      ))}
      <text fg={palette.fg}>Open scratch files</text>
      {[...new Set(files)].map((file) => (
        <text key={file} fg={palette.fg}>
          {safe(file)}
        </text>
      ))}
    </box>
  );
}
