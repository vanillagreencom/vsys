import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import type { Scratch, Snapshot, Volume } from "../model/types";
import type { Level } from "../model/verdict";
import { type WriteTotal, writeTotals } from "../model/writes";
import { columnGap, fit } from "./columns";
import { age, amount, gap } from "./format";
import { useScreenKeys } from "./keys";
import { levelColor, metric, scrollbar, ui } from "./theme";
import {
  Bar,
  Empty,
  Field,
  Line,
  nextDown,
  Reading,
  Row,
  Section,
} from "./widgets";

/** Everything the reader can select on Storage, top to bottom. */
export type StorageItem =
  | { kind: "volume"; volume: Volume }
  | { kind: "scrub"; path: string }
  | { kind: "scratch"; scratch: Scratch; session: boolean };
/** The path each selectable row stands for, which a card can name. */
export function itemPath(item: StorageItem): string {
  if (item.kind === "volume") return item.volume.mount;
  return item.kind === "scrub" ? item.path : item.scratch.path;
}
export function storageItems(s: Snapshot): StorageItem[] {
  return [
    // Grouped by device, because that is the order the rows are drawn in and
    // the selection counts them as it draws them.
    ...volumesByDevice(s.storage.volumes).flatMap((group) =>
      group.volumes.map((volume) => ({ kind: "volume", volume }) as const),
    ),
    ...s.storage.scrubs.map(
      (scrub) => ({ kind: "scrub", path: scrub.path }) as const,
    ),
    ...s.storage.scratch.map(
      (scratch) => ({ kind: "scratch", scratch, session: false }) as const,
    ),
    ...s.storage.sessions.map(
      (scratch) => ({ kind: "scratch", scratch, session: true }) as const,
    ),
  ];
}
/**
 * Btrfs subvolumes of one filesystem each mount separately and each report the
 * whole device's free space, so seven rows repeat one long device name and one
 * free-space figure. The device is named once and its mounts sit under it.
 */
export interface DeviceVolumes {
  /** The identity the group was formed on: the filesystem id where resolved. */
  id: string;
  /** The device a reader would type, taken from the group's first mount. */
  device: string;
  volumes: Volume[];
}
/**
 * What identifies the filesystem a mount belongs to. The collector resolves a
 * Btrfs filesystem id per mount, and that is the identity the counters are
 * keyed by. The mount source is not: one filesystem reached through a mapper
 * alias, a canonical path or a second member device carries three different
 * source strings and would split into three headings, each repeating the one
 * free-space figure this grouping exists to state once. The source is the
 * fallback for a mount whose filesystem id could not be resolved.
 */
const filesystemKey = (v: Volume): string => v.fsid ?? v.device;
export function volumesByDevice(volumes: Volume[]): DeviceVolumes[] {
  const order: string[] = [];
  const byDevice = new Map<string, Volume[]>();
  for (const volume of volumes) {
    const key = filesystemKey(volume);
    const group = byDevice.get(key);
    if (group) group.push(volume);
    else {
      byDevice.set(key, [volume]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const volumes = byDevice.get(key) ?? [];
    // The heading names the device a reader would type. The identity stays
    // beside it, because two filesystems can report one device string and
    // only the id tells the groups apart.
    return { id: key, device: volumes[0]?.device ?? key, volumes };
  });
}
export function volumeLevel(v: Volume, freeFloor: number): Level {
  if (v.readOnly || Object.values(v.delta).some((n) => n > 0)) return "danger";
  if (v.free !== null && v.free < freeFloor) return "danger";
  return "ok";
}
/** The error counters a volume reports, only those above zero. */
function errorText(v: Volume): string {
  const raised = Object.entries(v.errors).filter(([, n]) => n > 0);
  if (v.countersAvailable === false) return "device counters not available";
  if (!raised.length) return "no device errors";
  return raised
    .map(([kind, n]) => {
      const short =
        kind
          .split("/")
          .at(-1)
          ?.replace(/_errs$/, "") ?? kind;
      return `${short} ${n}${v.delta[kind] ? ` (+${v.delta[kind]})` : ""}`;
    })
    .join(" · ");
}

/** Written bytes lead, because drives wear by what is written to them. */
export function Storage({
  snapshot: s,
  config: c,
  width,
  target,
  onTargetUsed,
  onNotice,
}: {
  snapshot: Snapshot;
  config: Config;
  width: number;
  /** The mount, report or directory a card asked this screen to land on. */
  target: string | null;
  onTargetUsed: () => void;
  onNotice: (text: string, level: Level) => void;
}) {
  const [selected, setSelected] = useState(0);
  const items = storageItems(s);
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    scroller.current?.scrollChildIntoView(`storage-${selected}`);
  }, [selected]);
  // A card names a row and this lands on it. The row is found before the
  // request is acknowledged, because a collector refresh between the keypress
  // and this effect can remove the mount or directory it named. Acknowledging
  // first dropped the request in silence, leaving a screen that looks like the
  // reader never pressed anything. The request is still consumed either way,
  // so opening the same card twice lands twice.
  useEffect(() => {
    if (target === null) return;
    const at = storageItems(s).findIndex((item) => itemPath(item) === target);
    if (at >= 0) setSelected(at);
    else onNotice(`${target} is no longer in the sample`, "warn");
    onTargetUsed();
  }, [target, onTargetUsed, onNotice, s]);
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down") {
      setSelected((i) => nextDown(items.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setSelected((i) => Math.max(0, i - 1));
      return true;
    }
    return false;
  });
  const totals = writeTotals(s, c);
  const writeRows = (
    rows: WriteTotal[],
    available: boolean,
    label: string,
    unread = "",
  ) => {
    if (!available || !rows.length) return <Empty text={`${label}: ${gap}`} />;
    const top = Math.max(1, ...rows.map((r) => r.written ?? 0));
    // A section with no readable total has no scale, so it shows no bars.
    const measured = rows.some((r) => r.written !== null);
    // Every row reading "not available" is one fact, not a list: it says the
    // source was unreadable, and repeating it per row says nothing more.
    if (!measured && unread)
      return (
        <Empty
          text={`${label}: ${gap} for any of the ${rows.length} drives. ${unread}`}
        />
      );
    return rows.map((row) => (
      <Line key={row.name} height={1} flexShrink={0} truncate>
        {safe(fit(row.name, 28))}
        {columnGap}
        {measured && (
          <Bar value={row.written} max={top} width={16} color={metric.disk} />
        )}
        {columnGap}
        <Reading
          value={row.written}
          text={
            measured
              ? fit(amount(row.written, c), 10, "right")
              : amount(row.written, c)
          }
        />
      </Line>
    ));
  };
  const mapped = totals.devices.some((d) => /^dm-/.test(d.name));
  let index = -1;
  const next = () => ++index;
  const st = s.storage;
  const scanState = st.scratchPending
    ? "measuring"
    : st.scratchTime == null
      ? "not measured yet"
      : `measured ${new Date(st.scratchTime).toLocaleTimeString()}`;
  const scratchTop = Math.max(
    c.scratchQuota,
    ...[...st.scratch, ...st.sessions].map((x) => x.bytes ?? 0),
  );
  const volumeRow = (v: Volume) => {
    const i = next();
    const level = volumeLevel(v, c.freeFloor);
    return (
      <box
        id={`storage-${i}`}
        key={v.mount}
        flexDirection="column"
        flexShrink={0}
      >
        <Row
          selected={i === selected}
          color={levelColor(level)}
          onOpen={() => setSelected(i)}
        >
          {"  "}
          {safe(fit(v.mount, 40))}
          {v.readOnly && <span fg={ui.danger}>read-only</span>}
        </Row>
        {i === selected && (
          <box flexDirection="column" flexShrink={0} paddingLeft={4}>
            {/* The device row above names the device and its error counters
                once for every mount grouped under it, and subvolumes of one
                filesystem share both. The options are the mount's own. */}
            <Field label="Options" value={v.options.join(", ")} />
          </box>
        )}
      </box>
    );
  };
  const scratchRow = (item: Extract<StorageItem, { kind: "scratch" }>) => {
    const i = next();
    const x = item.scratch;
    const over = x.bytes !== null && !item.session && x.bytes > c.scratchQuota;
    const modified = age(
      x.modifiedAt == null
        ? x.age
        : Math.max(0, (s.time - x.modifiedAt) / 1000),
    );
    return (
      <box
        id={`storage-${i}`}
        key={x.path}
        flexDirection="column"
        flexShrink={0}
      >
        <Row
          selected={i === selected}
          color={over ? ui.warn : undefined}
          onOpen={() => setSelected(i)}
        >
          {safe(fit(x.path, 40))}
          {columnGap}
          <Bar
            value={x.bytes}
            max={scratchTop}
            width={12}
            level={over ? "warn" : "ok"}
          />
          {columnGap}
          <Reading
            value={x.bytes}
            text={fit(amount(x.bytes, c), 10, "right")}
          />
          <span attributes={ui.dim}>{`  ${modified} ago`}</span>
          {x.error && <span fg={ui.warn}>{`  ${safe(x.error)}`}</span>}
        </Row>
      </box>
    );
  };
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
        <Section title="Written since boot" width={width} marginTop={0} />
        {writeRows(totals.slices, true, "by slice")}
        <box height={1} flexShrink={0} />
        {writeRows(totals.devices, totals.devicesAvailable, "by drive")}
        {mapped && (
          <Line height={1} flexShrink={0} truncate attributes={ui.dim}>
            A dm- row repeats the writes of the disk beneath it.
          </Line>
        )}
        <Section title="Drive lifetime writes" width={width} />
        {writeRows(
          totals.lifetime,
          true,
          "lifetime",
          `vsys runs no privileged helper, so it reads what a timer leaves in ${c.smartDir}.`,
        )}
        <Section
          title="Filesystems"
          width={width}
          count={st.volumes.length || undefined}
        />
        {st.mountsAvailable === false && (
          <Empty text="Mount information is not available." />
        )}
        {st.mountsAvailable !== false && !st.volumes.length && (
          <Empty text="No watched Btrfs mount." />
        )}
        {volumesByDevice(st.volumes).map(({ id, device, volumes }) => {
          // Subvolumes of one filesystem each report the whole device's free
          // space, so the device states it once and its mounts carry only what
          // differs between them. `statfs` is attempted per mount, so one
          // member can have failed where another succeeded: read the figures
          // from a member that has them rather than from whichever came first.
          const first =
            volumes.find((v) => v.free !== null && v.total !== null) ??
            volumes[0];
          const used =
            first.total !== null && first.free !== null
              ? first.total - first.free
              : null;
          const worst: Level = volumes.some(
            (v) => volumeLevel(v, c.freeFloor) === "danger",
          )
            ? "danger"
            : "ok";
          return (
            <box key={id} flexDirection="column" flexShrink={0}>
              <Line height={1} flexShrink={0} truncate>
                <span fg={levelColor(worst)}>{safe(fit(device, 42))}</span>
                {columnGap}
                <Bar
                  value={used}
                  max={first.total ?? 1}
                  width={12}
                  level={worst}
                />
                {`${columnGap}${fit(amount(first.free, c), 10, "right")} free of ${amount(first.total, c)}`}
                <span attributes={ui.dim}>
                  {`  ${volumes.length} ${volumes.length === 1 ? "mount" : "mounts"}`}
                </span>
              </Line>
              {/* The row above fills a hundred-column terminal with its fixed
                  columns, so the counters got none and were cut away whole.
                  They are the reading behind the row's colour and the only
                  copy of it, so they wrap on a line of their own, once per
                  device, where a narrow terminal can still show them. */}
              <Line
                flexShrink={0}
                wrapMode="word"
                paddingLeft={2}
                fg={worst === "danger" ? ui.danger : undefined}
                attributes={worst === "danger" ? ui.none : ui.dim}
              >
                {safe(errorText(first))}
              </Line>
              {volumes.map(volumeRow)}
            </box>
          );
        })}
        <Section
          title="Scrub reports"
          width={width}
          count={st.scrubs.length || undefined}
        />
        {!st.scrubs.length && (
          <Empty text="No scrub report in the report directory." />
        )}
        {st.scrubs.map((scrub) => {
          const i = next();
          return (
            <box
              id={`storage-${i}`}
              key={scrub.path}
              flexDirection="column"
              flexShrink={0}
            >
              <Row
                selected={i === selected}
                color={scrub.problem ? ui.danger : undefined}
                onOpen={() => setSelected(i)}
              >
                {safe(scrub.path)}
                <span attributes={scrub.problem ? ui.none : ui.dim}>
                  {scrub.problem ? "  problem reported" : "  clean"}
                </span>
              </Row>
              {i === selected && (
                <Line
                  flexShrink={0}
                  wrapMode="word"
                  paddingLeft={2}
                  attributes={ui.dim}
                >
                  {safe(scrub.text)}
                </Line>
              )}
            </box>
          );
        })}
        <Section
          width={width}
          title="Scratch"
          count={`${scanState} · quota ${amount(c.scratchQuota, c)}`}
        />
        {!st.scratch.length && !st.sessions.length && (
          <Empty text="No scratch directory is configured." />
        )}
        {items.filter((item) => item.kind === "scratch").map(scratchRow)}
      </box>
    </scrollbox>
  );
}
