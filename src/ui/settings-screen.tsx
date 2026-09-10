import type { ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import { type Config, validate } from "../config/config";
import {
  settingText as editText,
  settingValue as editValue,
} from "../config/editor";
import { safe } from "../model/export";
import type { Snapshot } from "../model/types";
import type { Level } from "../model/verdict";
import { keyLabel, wideWidth } from "./chrome";
import { columnGap, fit } from "./columns";
import { useScreenKeys } from "./keys";
import {
  capabilityLabels,
  capabilityReason,
  settingDisplay,
  settingGroups,
  settingHelp,
  settingLabel,
} from "./settings";
import { scrollbar, ui } from "./theme";
import { Empty, Line, nextDown, Row, Section } from "./widgets";

/** A selectable line on Settings: a stored value, or the unreadable sources. */
export type SettingItem =
  | { kind: "setting"; key: string }
  | { kind: "sources" };
export function settingItems(c: Config, query = ""): SettingItem[] {
  const q = query.trim().toLowerCase();
  // A filter matches the name the reader sees and the name they would write
  // in the config file, so either spelling finds the row.
  const matches = (key: string) =>
    !q ||
    key.toLowerCase().includes(q) ||
    settingLabel(key).toLowerCase().includes(q);
  return [
    ...(q ? [] : [{ kind: "sources" } as const]),
    ...settingGroups.flatMap(([, keys]) =>
      keys.filter(matches).map((key) => ({ kind: "setting", key }) as const),
    ),
    ...Object.keys(c.keys)
      .map((key) => `keys.${key}`)
      .filter(matches)
      .map((key) => ({ kind: "setting", key }) as const),
  ];
}
/** Errors counted once per source, worst sources first. */
export function sourceCounts(s: Snapshot): [string, number][] {
  const counts = new Map<string, number>();
  for (const e of s.errors)
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
const settingValue = (c: Config, key: string): unknown =>
  key.startsWith("keys.") ? c.keys[key.slice(5)] : c[key as keyof Config];

/** What vsys can read on this machine, then every stored setting by group. */
export function Settings({
  snapshot: s,
  config: c,
  width,
  onSave,
  onNotice,
}: {
  snapshot: Snapshot;
  config: Config;
  width: number;
  onSave: (c: Config) => Promise<void>;
  onNotice: (text: string, level: Level) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const items = settingItems(c, query);
  // Two columns above the stated width: forty-four settings down one column
  // leave two thirds of a wide terminal empty.
  const twoColumns = width >= wideWidth && !editing;
  const column = twoColumns ? Math.floor((width - 3) / 2) : width;
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    scroller.current?.scrollChildIntoView(`setting-${selected}`);
  }, [selected]);
  // A query can match nothing, so no row is selected and no row is rendered.
  const current: SettingItem | undefined = items[selected];
  const beginEdit = (index: number) => {
    const item: SettingItem | undefined = items[index];
    if (item?.kind !== "setting") return;
    setSelected(index);
    setInput(editText(settingValue(c, item.key)));
    setEditing(true);
  };
  async function commit(text: string) {
    if (current?.kind !== "setting") return;
    try {
      const key = current.key;
      const parsed = editValue(settingValue(c, key), text);
      const next = key.startsWith("keys.")
        ? { ...c, keys: { ...c.keys, [key.slice(5)]: parsed } }
        : { ...c, [key]: parsed };
      await onSave(validate(next));
      setEditing(false);
      onNotice(`${settingLabel(key)} saved`, "ok");
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : String(error),
        "danger",
      );
    }
  }
  useScreenKeys((name, key) => {
    if (searching) {
      if (name === c.keys.back) {
        key.preventDefault();
        setSearching(false);
        setQuery("");
        setSelected(0);
      }
      return true;
    }
    if (name === c.keys.search && !editing) {
      key.preventDefault();
      setSearching(true);
      setSelected(0);
      return true;
    }
    if (editing) {
      if (name === c.keys.back) {
        key.preventDefault();
        setEditing(false);
      }
      return true;
    }
    if (name === c.keys.down || name === "down") {
      setSelected((i) => nextDown(items.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      setSelected((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.open) {
      if (current?.kind === "sources") setSourcesOpen((v) => !v);
      else beginEdit(selected);
      return true;
    }
    return false;
  });
  const sources = sourceCounts(s);
  const missing = s.capabilities.filter((cap) => !cap.available);
  const shown = new Set(
    items.flatMap((item) => (item.kind === "setting" ? [item.key] : [])),
  );
  const sections = [
    ...settingGroups.map(([title, keys]) => ({
      title,
      keys: keys.filter((key) => shown.has(key)),
    })),
    {
      title: "Keys",
      keys: Object.keys(c.keys)
        .map((key) => `keys.${key}`)
        .filter((key) => shown.has(key)),
    },
  ].filter((section) => section.keys.length);
  // The split keeps the sections in the order `settingItems` lists them, so a
  // row's position in the render is its position in the selection.
  const rowsTotal = sections.reduce(
    (total, section) => total + section.keys.length + 1,
    0,
  );
  let running = 0;
  const left = sections.filter((section) => {
    const before = running;
    running += section.keys.length + 1;
    return before < rowsTotal / 2;
  });
  const sides = twoColumns ? [left, sections.slice(left.length)] : [sections];
  // A row's index is its position in `items`, looked up rather than counted
  // alongside it. A counter and a list can disagree, and a filter that drops a
  // row from the list while the render still counts it is how they do: the
  // highlight then sits on one row while Enter opens another.
  const sourcesIndex = items.findIndex((item) => item.kind === "sources");
  const settingIndex = (key: string) =>
    items.findIndex((item) => item.kind === "setting" && item.key === key);
  const settingRow = (key: string) => {
    const i = settingIndex(key);
    const help = settingHelp(key);
    return (
      <box id={`setting-${i}`} key={key} flexDirection="column" flexShrink={0}>
        <Row selected={i === selected} onOpen={() => beginEdit(i)}>
          {fit(settingLabel(key), 24)}
          {columnGap}
          <span attributes={i === selected ? ui.none : ui.dim}>
            {safe(settingDisplay(key, settingValue(c, key), c))}
          </span>
        </Row>
        {!editing && i === selected && help !== "" && (
          <Line
            flexShrink={0}
            wrapMode="word"
            paddingLeft={3}
            attributes={ui.dim}
          >
            {help}
          </Line>
        )}
        {editing && i === selected && (
          <box
            height={3}
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={ui.accent}
            title={` ${settingLabel(key)} · ${keyLabel(c.keys.open)} saves · ${keyLabel(c.keys.back)} cancels `}
          >
            <input
              focused
              value={input}
              onInput={setInput}
              onSubmit={() => {
                void commit(input);
              }}
            />
          </box>
        )}
      </box>
    );
  };
  return (
    <scrollbox
      ref={scroller}
      flexGrow={1}
      minHeight={0}
      scrollY
      focused={!editing}
      verticalScrollbarOptions={scrollbar}
      contentOptions={{ flexShrink: 0 }}
    >
      <box flexDirection="column" flexShrink={0} paddingX={2}>
        {searching && (
          <box
            height={3}
            flexShrink={0}
            border
            borderStyle="rounded"
            borderColor={ui.accent}
            title=" Find a setting "
          >
            <input
              focused
              value={query}
              placeholder="name or label"
              onInput={setQuery}
              onSubmit={() => setSearching(false)}
            />
          </box>
        )}
        <Section
          title="Data sources"
          width={width}
          count={
            missing.length ? `${missing.length} not available` : "all available"
          }
          marginTop={0}
        />
        {s.capabilities.map((cap) => (
          <Line key={cap.id} height={1} flexShrink={0} truncate>
            <span fg={cap.available ? ui.ok : ui.warn}>
              {cap.available ? "● " : "○ "}
            </span>
            {fit(capabilityLabels[cap.id], 42)}
            <span attributes={ui.dim}>
              {cap.available
                ? "available"
                : safe(
                    `${capabilityReason(cap)} (${cap.source}: ${cap.detail})`,
                  )}
            </span>
          </Line>
        ))}
        {!s.capabilities.length && (
          <Empty text="This sample was recorded before vsys probed its sources." />
        )}
        {sourcesIndex >= 0 && (
          <box
            id={`setting-${sourcesIndex}`}
            flexDirection="column"
            flexShrink={0}
          >
            <Row
              selected={sourcesIndex === selected}
              color={sources.length ? ui.warn : undefined}
              onOpen={() => setSourcesOpen((v) => !v)}
            >
              <span fg={ui.accent}>{sourcesOpen ? "▾ " : "▸ "}</span>
              {sources.length
                ? `${sources.length} ${sources.length === 1 ? "source" : "sources"} vsys cannot read`
                : "Every source was read"}
            </Row>
            {sourcesOpen &&
              sources.map(([source, n]) => (
                <Line
                  key={source}
                  height={1}
                  flexShrink={0}
                  truncate
                  paddingLeft={3}
                >
                  {safe(fit(source, 48))}
                  <span attributes={ui.dim}>
                    {safe(
                      `${s.errors.find((e) => e.source === source)?.message ?? ""}${n > 1 ? ` (${n} reads)` : ""}`,
                    )}
                  </span>
                </Line>
              ))}
          </box>
        )}
        <box
          flexDirection={twoColumns ? "row" : "column"}
          flexShrink={0}
          gap={twoColumns ? 3 : 0}
        >
          {sides.map((side, at) => (
            <box
              // biome-ignore lint/suspicious/noArrayIndexKey: a side is its position
              key={`side-${at}`}
              flexDirection="column"
              flexShrink={0}
              flexGrow={twoColumns ? 1 : 0}
              flexBasis={twoColumns ? 0 : undefined}
              minWidth={0}
            >
              {side.map(({ title, keys }) => (
                <box key={title} flexDirection="column" flexShrink={0}>
                  <Section title={title} width={column} />
                  {keys.map(settingRow)}
                </box>
              ))}
            </box>
          ))}
        </box>
        <Line
          height={1}
          flexShrink={0}
          truncate
          attributes={ui.dim}
          marginTop={1}
        >
          {`Settings live in the config file. Lists are written as ["a", "b"].`}
        </Line>
      </box>
    </scrollbox>
  );
}
