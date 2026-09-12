import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import type { Config } from "../config/config";
import { safe } from "../model/export";
import {
  damageCounts,
  type Integrity,
  integrity,
  integrityLevel,
  volumesByDevice,
} from "../model/integrity";
import type { Scratch, Snapshot, Volume } from "../model/types";
import type { Level } from "../model/verdict";
import { type WriteTotal, writeTotals } from "../model/writes";
import { keyLabel, screenPad } from "./chrome";
import { columnGap, fit } from "./columns";
import { age, amount, gap } from "./format";
import {
  blocksText,
  counterSentence,
  damageAdvice,
  deleteCommand,
  integrityLine,
  noDamageText,
  rebuildCommand,
} from "./integrity";
import { useScreenKeys } from "./keys";
import {
  regionOf,
  regionRanges,
  stepToRegion,
  stepWithin,
  storageRegions,
} from "./regions";
import { levelColor, metric, scrollbar, ui } from "./theme";
import {
  Bar,
  Detail,
  Disclosure,
  Empty,
  Field,
  Ink,
  Line,
  Reading,
  Row,
  Section,
} from "./widgets";

/** Everything the reader can select on Storage, top to bottom. */
export type StorageItem =
  | { kind: "filesystem"; id: string }
  | { kind: "volume"; volume: Volume }
  | { kind: "scrub"; path: string }
  | { kind: "scratch"; scratch: Scratch; session: boolean };
/** The path each selectable row stands for, which a card can name. */
export function itemPath(item: StorageItem): string {
  // A filesystem is named by its identity, never by one of its mounts: a card
  // naming a mount means that mount's row, and the two would collide.
  if (item.kind === "filesystem") return item.id;
  if (item.kind === "volume") return item.volume.mount;
  return item.kind === "scrub" ? item.path : item.scratch.path;
}
export function storageItems(s: Snapshot): StorageItem[] {
  return [
    // Grouped by filesystem, because that is the order the rows are drawn in
    // and the selection counts them as it draws them. Each filesystem states
    // its integrity once, above the mounts that share it.
    ...volumesByDevice(s.storage.volumes).flatMap((group) => [
      { kind: "filesystem", id: group.id } as const,
      ...group.volumes.map((volume) => ({ kind: "volume", volume }) as const),
    ]),
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
  onCopy,
}: {
  snapshot: Snapshot;
  config: Config;
  width: number;
  /** The mount, report or directory a card asked this screen to land on. */
  target: string | null;
  onTargetUsed: () => void;
  onNotice: (text: string, level: Level) => void;
  /** Undefined text tells the shell the selected row carries no command. */
  onCopy: (command: string | undefined) => void;
}) {
  const [chosen, setSelected] = useState(0);
  const items = storageItems(s);
  // The selection held inside the rows there are: a list that shrinks under
  // it leaves the reader on its last row, and with no rows at all nothing is
  // selected and no region is focused.
  const within = (index: number) => Math.min(index, items.length - 1);
  const selected = within(chosen);
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
  // Storage's three lists are three regions of one flat selection, in the
  // order they are drawn: filesystems, scrub reports, scratch directories.
  const counts = [
    // A filesystem's integrity row and its mount rows are one region: they are
    // drawn together and the reader walks them with one pair of arrows.
    items.filter((item) => item.kind === "filesystem" || item.kind === "volume")
      .length,
    items.filter((item) => item.kind === "scrub").length,
    items.filter((item) => item.kind === "scratch").length,
  ];
  const region = regionOf(counts, selected);
  // With no rows there is nothing to move to, and the choice is kept for the
  // rows that arrive.
  const move = (to: (index: number) => number) => {
    if (items.length) setSelected((i) => to(within(i)));
    return true;
  };
  useScreenKeys((name) => {
    if (name === c.keys.down || name === "down")
      return move((i) => stepWithin(counts, i, 1));
    if (name === c.keys.up || name === "up")
      return move((i) => stepWithin(counts, i, -1));
    // No Storage row moves sideways, so left and right step between the lists
    // as the region key does.
    if (name === c.keys.previous || name === c.keys.left || name === "left")
      return move((i) => stepToRegion(counts, i, -1));
    if (name === c.keys.next || name === c.keys.right || name === "right")
      return move((i) => stepToRegion(counts, i, 1));
    // Only the filesystem row carries a command, and only where the last
    // check found build output to remove. Every other row copies nothing,
    // which the shell says rather than copying something the reader did not
    // select.
    if (name === c.keys.copy) {
      const item = items[selected];
      const group =
        item?.kind === "filesystem"
          ? volumesByDevice(s.storage.volumes).find((g) => g.id === item.id)
          : undefined;
      onCopy(
        group
          ? rebuildCommand(integrity(group, s.storage.scrubs, s.time, c))
          : undefined,
      );
      return true;
    }
    // A list's own key lands on its first row. A list with no row has no row
    // to land on, so its key leaves the selection where it is.
    const jump = storageRegions.findIndex(
      ({ action }) => name === c.keys[action],
    );
    if (jump < 0) return false;
    if (counts[jump]) setSelected(regionRanges(counts)[jump][0]);
    return true;
  });
  /** A list's heading: its title, the key that jumps to it, and its focus. */
  const heading = (at: number) => ({
    title: storageRegions[at].title,
    hotkey: c.keys[storageRegions[at].action],
    focused: region === at,
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
  /**
   * One filesystem's integrity, in plain words with both of its times. What
   * the check found sits one level down, and the raw counters and the raw
   * report text one level below that: a reader asking "is my data damaged"
   * gets the answer without opening anything.
   */
  const integrityRow = (item: Integrity, first: Volume) => {
    const i = next();
    const level = integrityLevel(item.state);
    const counts = damageCounts(item);
    const rebuild = rebuildCommand(item);
    return (
      <box
        id={`storage-${i}`}
        key={`integrity-${item.id}`}
        flexDirection="column"
        flexShrink={0}
      >
        <Row
          selected={i === selected}
          color={level === "ok" ? undefined : levelColor(level)}
          onOpen={() => setSelected(i)}
        >
          <Disclosure
            open={i === selected}
            name={integrityLine(item)}
            count={counts.files || undefined}
          />
        </Row>
        {i === selected && (
          <Detail indent={4}>
            {/* The headline reading is what the last check found. The
                lifetime counter is a different quantity and sits below it. */}
            <Field label="Blocks found" width={16} value={blocksText(item)} />
            {item.groups.length === 0 && <Empty text={noDamageText(item)} />}
            {item.groups.map((group) => {
              const command = deleteCommand(group);
              return (
                <box
                  key={group.logical}
                  flexDirection="column"
                  flexShrink={0}
                  marginTop={1}
                >
                  <Line height={1} flexShrink={0} truncate>
                    <span attributes={ui.dim}>{fit("block", 16)}</span>
                    {`${group.logical}  `}
                    <span fg={group.kind === "other" ? ui.danger : undefined}>
                      {damageAdvice(group)}
                    </span>
                  </Line>
                  {group.paths.map((path) => (
                    <Line key={path} flexShrink={0} wrapMode="word">
                      {`      ${safe(path)}`}
                    </Line>
                  ))}
                  {command && (
                    <Line
                      flexShrink={0}
                      wrapMode="word"
                      fg={ui.accent}
                    >{`      ${safe(command)}`}</Line>
                  )}
                </box>
              );
            })}
            {rebuild && (
              <Line flexShrink={0} wrapMode="word" attributes={ui.dim}>
                {`${keyLabel(c.keys.copy)} copies one line that removes every build-output path above.`}
              </Line>
            )}
            <box height={1} flexShrink={0} />
            <Line flexShrink={0} wrapMode="word" attributes={ui.dim}>
              {counterSentence}
            </Line>
            <Field label="Counter" width={16} value={errorText(first)} />
            {item.scrub && (
              <Line flexShrink={0} wrapMode="word" attributes={ui.dim}>
                {safe(item.scrub.text)}
              </Line>
            )}
          </Detail>
        )}
      </box>
    );
  };
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
          <Disclosure open={i === selected} name={fit(v.mount, 40)} />
          {v.readOnly && <Ink color={ui.danger}>read-only</Ink>}
        </Row>
        {i === selected && (
          <Detail indent={4}>
            {/* The device row above names the device and its error counters
                once for every mount grouped under it, and subvolumes of one
                filesystem share both. The options are the mount's own. */}
            <Field label="Options" value={v.options.join(", ")} />
          </Detail>
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
          {x.error && <Ink color={ui.warn}>{`  ${safe(x.error)}`}</Ink>}
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
      scrollbarOptions={scrollbar}
      contentOptions={{ flexShrink: 0 }}
    >
      <box flexDirection="column" flexShrink={0} paddingX={screenPad}>
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
          {...heading(0)}
          width={width}
          count={st.volumes.length || undefined}
        />
        {st.mountsAvailable === false && (
          <Empty text="Mount information is not available." />
        )}
        {st.mountsAvailable !== false && !st.volumes.length && (
          <Empty text="No watched Btrfs mount." />
        )}
        {volumesByDevice(st.volumes).map((group) => {
          const { id, device, volumes } = group;
          const state = integrity(group, st.scrubs, s.time, c);
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
          // The heading's colour is the worse of what its mounts report and
          // what the filesystem's integrity says, so damage found by a check
          // colours the heading even while every mount reads normally.
          const worst: Level =
            volumes.some((v) => volumeLevel(v, c.freeFloor) === "danger") ||
            integrityLevel(state.state) === "danger"
              ? "danger"
              : integrityLevel(state.state) === "warn"
                ? "warn"
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
              {integrityRow(state, first)}
              {volumes.map(volumeRow)}
            </box>
          );
        })}
        <Section
          {...heading(1)}
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
                {/* A file vsys could not read reported nothing at all, and
                    saying it reported a problem puts words in it. */}
                <span attributes={scrub.problem ? ui.none : ui.dim}>
                  {scrub.readable === false
                    ? "  could not be read"
                    : scrub.problem
                      ? "  problem reported"
                      : "  clean"}
                </span>
              </Row>
              {i === selected && (
                <Detail indent={2}>
                  <Line flexShrink={0} wrapMode="word" attributes={ui.dim}>
                    {safe(scrub.text)}
                  </Line>
                </Detail>
              )}
            </box>
          );
        })}
        <Section
          {...heading(2)}
          width={width}
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
