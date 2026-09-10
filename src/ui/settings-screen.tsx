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
import { keyLabel } from "./chrome";
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
export function settingItems(c: Config): SettingItem[] {
  return [
    { kind: "sources" },
    ...settingGroups.flatMap(([, keys]) =>
      keys.map((key) => ({ kind: "setting", key }) as const),
    ),
    ...Object.keys(c.keys).map(
      (key) => ({ kind: "setting", key: `keys.${key}` }) as const,
    ),
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
  const items = settingItems(c);
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    scroller.current?.scrollChildIntoView(`setting-${selected}`);
  }, [selected]);
  const current = items[selected];
  const beginEdit = (index: number) => {
    const item = items[index];
    if (item.kind !== "setting") return;
    setSelected(index);
    setInput(editText(settingValue(c, item.key)));
    setEditing(true);
  };
  async function commit(text: string) {
    if (current.kind !== "setting") return;
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
      if (current.kind === "sources") setSourcesOpen((v) => !v);
      else beginEdit(selected);
      return true;
    }
    return false;
  });
  const sources = sourceCounts(s);
  const missing = s.capabilities.filter((cap) => !cap.available);
  let index = 0;
  const settingRow = (key: string) => {
    const i = index++;
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
        {(() => {
          const i = index++;
          return (
            <box id={`setting-${i}`} flexDirection="column" flexShrink={0}>
              <Row
                selected={i === selected}
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
          );
        })()}
        {settingGroups.map(([group, keys]) => (
          <box key={group} flexDirection="column" flexShrink={0}>
            <Section title={group} width={width} />
            {keys.map(settingRow)}
          </box>
        ))}
        <Section title="Keys" width={width} />
        {Object.keys(c.keys).map((key) => settingRow(`keys.${key}`))}
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
