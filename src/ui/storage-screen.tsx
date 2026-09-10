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
export function storageItems(s: Snapshot): StorageItem[] {
  return [
    ...s.storage.volumes.map((volume) => ({ kind: "volume", volume }) as const),
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
}: {
  snapshot: Snapshot;
  config: Config;
  width: number;
}) {
  const [selected, setSelected] = useState(0);
  const items = storageItems(s);
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    scroller.current?.scrollChildIntoView(`storage-${selected}`);
  }, [selected]);
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
  const writeRows = (rows: WriteTotal[], available: boolean, label: string) => {
    if (!available || !rows.length) return <Empty text={`${label}: ${gap}`} />;
    const top = Math.max(1, ...rows.map((r) => r.written ?? 0));
    // A section with no readable total has no scale, so it shows no bars.
    const measured = rows.some((r) => r.written !== null);
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
        {writeRows(totals.lifetime, true, "lifetime")}
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
        {st.volumes.map((v) => {
          const i = next();
          const level = volumeLevel(v, c.freeFloor);
          const used =
            v.total !== null && v.free !== null ? v.total - v.free : null;
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
                {safe(fit(v.mount, 24))}
                {columnGap}
                <Bar value={used} max={v.total ?? 1} width={12} level={level} />
                {`${columnGap}${fit(amount(v.free, c), 10, "right")} free of ${amount(v.total, c)}`}
                {v.readOnly ? (
                  <span fg={ui.danger}> read-only</span>
                ) : (
                  <span attributes={ui.dim}>{`  ${safe(v.device)}`}</span>
                )}
              </Row>
              {i === selected && (
                <box flexDirection="column" flexShrink={0} paddingLeft={2}>
                  <Field
                    label="Errors"
                    value={errorText(v)}
                    color={level === "danger" ? ui.danger : undefined}
                  />
                  <Field label="Options" value={v.options.join(", ")} />
                </box>
              )}
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
