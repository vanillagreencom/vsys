import { CliRenderEvents, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Config, choices, isKeyAction, validate } from "../config/config";
import {
  settingText as editText,
  settingValue as editValue,
} from "../config/editor";
import { safe } from "../model/export";
import type { Capability, CapabilityId, Snapshot } from "../model/types";
import type { Level } from "../model/verdict";
import { keyLabel, screenPad, wideWidth } from "./chrome";
import { columnGap, fit } from "./columns";
import { useScreenKeys } from "./keys";
import { errorText } from "./refusals";
import { rowsById } from "./selection";
import {
  capabilityGives,
  capabilityLabels,
  capabilityLoss,
  capabilityOffer,
  capabilityReason,
  editorKind,
  reporterOffer,
  settingDisplay,
  settingGroups,
  settingHelp,
  settingLabel,
  settingsFileInfo,
} from "./settings";
import { scrollbar, statusColor, textInput, ui } from "./theme";
import {
  CommandOffer,
  Detail,
  Disclosure,
  Empty,
  Field,
  Ink,
  Line,
  ListRow,
  nextDown,
  Row,
  Section,
} from "./widgets";

/**
 * A selectable line on Settings: a probed capability, a stored value, or the
 * unreadable sources. A capability row is selectable because its reason and
 * its source are longer than a row, and a reader who cannot select it cannot
 * read past the truncation.
 */
export type SettingItem =
  | { kind: "capability"; id: CapabilityId }
  | { kind: "setting"; key: string }
  | { kind: "sources" }
  | { kind: "settingsFile" };
/** What tells one Settings row from another, whichever kind it is. */
function settingKey(item: SettingItem): string {
  switch (item.kind) {
    case "capability":
      return `capability:${item.id}`;
    case "setting":
      return `setting:${item.key}`;
    case "sources":
      return "sources";
    case "settingsFile":
      return "settingsFile";
    default: {
      const unknown: never = item;
      throw new Error(`Unknown setting row: ${String(unknown)}`);
    }
  }
}
export function settingItems(
  c: Config,
  capabilities: Capability[] = [],
  query = "",
): SettingItem[] {
  const q = query.trim().toLowerCase();
  // A filter matches the name the reader sees and the name they would write
  // in the config file, so either spelling finds the row.
  const matches = (key: string) =>
    !q ||
    key.toLowerCase().includes(q) ||
    settingLabel(key).toLowerCase().includes(q);
  return [
    // The capability rows are drawn whatever the filter says, so they are
    // listed whatever the filter says: the render and the selection read one
    // order or the selection lands on a row the reader is not looking at.
    ...capabilities.map((cap) => ({ kind: "capability", id: cap.id }) as const),
    ...(q
      ? []
      : [{ kind: "sources" } as const, { kind: "settingsFile" } as const]),
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
const settingValue = (c: Config, key: string): unknown => {
  if (!key.startsWith("keys.")) return c[key as keyof Config];
  const action = key.slice(5);
  return isKeyAction(c, action) ? c.keys[action] : undefined;
};

/** What vsys can read on this machine, then every stored setting by group. */
export function Settings({
  snapshot: s,
  config: c,
  settingsPath,
  width,
  onSave,
  onNotice,
  onCopy,
}: {
  snapshot: Snapshot;
  config: Config;
  /** The file an edit here will save to. */
  settingsPath: string;
  width: number;
  onSave: (c: Config) => Promise<void>;
  onNotice: (text: string, level: Level) => void;
  /** Undefined text tells the shell the selected row carries no command. */
  onCopy: (command: string | undefined) => void;
}) {
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState(false);
  const [picking, setPicking] = useState<string[] | null>(null);
  const [choice, setChoice] = useState(0);
  const [input, setInput] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // Which capability row has its source open. A row that could not be read
  // states its reason as soon as it is selected, because that is the thing the
  // reader came for. Where the reading worked there is nothing to explain, so
  // its source sits behind Enter: the footer offers Enter on this screen, and a
  // footer key is a promise that the row it lands on answers.
  const [openCap, setOpenCap] = useState<CapabilityId | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const items = settingItems(c, s.capabilities, query);
  // Two columns above the stated width: forty-four settings down one column
  // leave two thirds of a wide terminal empty.
  const twoColumns = width >= wideWidth && !editing && !picking;
  const column = twoColumns ? Math.floor((width - 3) / 2) : width;
  const scroller = useRef<ScrollBoxRenderable | null>(null);
  const renderer = useRenderer();
  // Read expansion from the block’s children, not an inventory of openers: a
  // selected capability or help sentence can expand without an explicit open
  // action. Child presence is known before layout; positions need the next
  // frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the column count, the editor, the sources row and an opened capability are re-run triggers here, not values the effect reads
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    if (picking) {
      // A picker is a list inside a row: what the reader is moving is one of
      // its options. Pointed at the setting instead, every option below the
      // fold could only be chosen blind.
      const onto = () => box.scrollChildIntoView(`choice-${choice}`);
      onto();
      // The second reading waits for the renderer's own next frame rather than
      // a fixed timeout, so it reads the option's layout after the row that
      // opened it has actually been laid out, not merely after one JS tick.
      renderer.once(CliRenderEvents.FRAME, onto);
      return () => {
        renderer.off(CliRenderEvents.FRAME, onto);
      };
    }
    const place = () => {
      const row = box.content.findDescendantById(`setting-${selected}`);
      if (!row) return;
      // What is drawn under the row is read as a count of children rather than
      // as a height: the detail is in the tree as soon as it is rendered, and
      // its height is not known until the layout after that. A measurement in
      // rows would be right one pass too late.
      const block = box.content.findDescendantById(`block-${selected}`);
      if (!block || block.getChildrenCount() < 2) {
        // Nothing under the row: bringing the row into view is the whole of
        // it. Scrolling to the block here is what pushed the row off the top
        // edge the moment the block grew a line.
        box.scrollChildIntoView(`setting-${selected}`);
        return;
      }
      // Something is under it, so the row goes near the top and the viewport
      // below is left for whatever it opened.
      box.scrollBy(row.y - box.viewport.y - 1);
    };
    place();
    // The second reading waits for the renderer's own next frame because the
    // opened detail's height is not known until the layout after the render
    // that grew it; a bare timeout can fire before that render under the live
    // renderer's own frame timer and read the block's old height.
    renderer.once(CliRenderEvents.FRAME, place);
    return () => {
      renderer.off(CliRenderEvents.FRAME, place);
    };
  }, [
    selected,
    twoColumns,
    picking,
    choice,
    editing,
    sourcesOpen,
    openCap,
    renderer,
  ]);
  /** Typing, opening and clearing search must choose through one owner. Capability rows are always listed, so row zero need not be the first query match. */
  const filterTo = (text: string) => {
    setQuery(text);
    if (!text.trim()) {
      setSelected(0);
      return;
    }
    // No match means no row rather than the first one. `nextDown` takes -1 to
    // the first visible row, so the arrows still work from here.
    setSelected(
      settingItems(c, s.capabilities, text).findIndex(
        (item) => item.kind === "setting",
      ),
    );
  };
  // A query can match nothing, so no row is selected and no row is rendered.
  const current: SettingItem | undefined = items[selected];
  /**
   * The one way a setting reaches the file. A toggle, a pick and a typed value
   * all arrive here, so every kind is validated before it is saved and none can
   * grow a shorter path.
   */
  async function save(key: string, read: () => unknown) {
    try {
      // Produce the value inside try: half-typed TOML may throw, and the save
      // must turn that into a notice instead of losing the keypress.
      const parsed = read();
      const next = key.startsWith("keys.")
        ? { ...c, keys: { ...c.keys, [key.slice(5)]: parsed } }
        : { ...c, [key]: parsed };
      await onSave(validate(next));
      setEditing(false);
      setPicking(null);
      onNotice(`${settingLabel(key)} saved`, "ok");
    } catch (error) {
      onNotice(errorText(error), "danger");
    }
  }
  /**
   * What Enter does on a setting, by the kind of value it holds. A boolean has
   * two states and needs no editor; an enum has a listed set and needs no
   * grammar; everything else opens the text box.
   */
  const beginEdit = (key: string) => {
    const value = settingValue(c, key);
    const kind = editorKind(key, value);
    if (kind === "toggle") {
      void save(key, () => !value);
      return;
    }
    if (kind === "choice") {
      const allowed = [...(choices[key] ?? [])];
      setChoice(Math.max(0, allowed.indexOf(String(value))));
      setPicking(allowed);
      return;
    }
    setInput(editText(value));
    setEditing(true);
  };
  /**
   * Open the row at `index`, which chooses it: the one answer to what opening
   * a row does, for Enter and for the mouse alike, so a click cannot select a
   * row without opening what Enter opens.
   */
  const openRow = (index: number) => {
    const item: SettingItem | undefined = items[index];
    // The find box, an editor and a picker each take every key until the
    // reader leaves them, so they take the mouse's row changes too: a click
    // elsewhere would move the selection off an editor the keys still feed.
    if (item === undefined || searching || editing || picking) return;
    setSelected(index);
    switch (item.kind) {
      case "sources":
        setSourcesOpen((v) => !v);
        return;
      case "capability":
        setOpenCap((v) => (v === item.id ? null : item.id));
        return;
      case "setting":
        beginEdit(item.key);
        return;
      case "settingsFile":
        // A path vsys resolved at start, not a stored setting: selecting it
        // already shows its help line, and there is nothing further to open.
        return;
      default: {
        const unknown: never = item;
        throw new Error(`Unknown setting row: ${String(unknown)}`);
      }
    }
  };
  async function commit(text: string) {
    if (current?.kind !== "setting") return;
    await save(current.key, () =>
      editValue(settingValue(c, current.key), text),
    );
  }
  useScreenKeys((name, key) => {
    if (searching) {
      if (name === c.keys.back) {
        key.preventDefault();
        setSearching(false);
        filterTo("");
      }
      return true;
    }
    // A picker owns every key until it closes, including the find key.
    if (name === c.keys.search && !editing && !picking) {
      key.preventDefault();
      setSearching(true);
      // The box opens on the query it still holds, so the row it leaves
      // selected is the one that query matched, not row zero.
      filterTo(query);
      return true;
    }
    if (picking) {
      key.preventDefault();
      if (name === c.keys.back) setPicking(null);
      else if (name === c.keys.down || name === "down")
        setChoice((i) => nextDown(picking.length, i));
      else if (name === c.keys.up || name === "up")
        setChoice((i) => Math.max(0, i - 1));
      else if (name === c.keys.open && current?.kind === "setting") {
        const option = picking[choice];
        if (option !== undefined) void save(current.key, () => option);
      }
      return true;
    }
    if (editing) {
      if (name === c.keys.back) {
        key.preventDefault();
        setEditing(false);
      }
      return true;
    }
    // Only a capability row offering a line to supply what is missing has
    // anything to copy: the scrub or drive reports row while it offers its
    // reporter's install or the scrub timers, or a row `capabilityOffer` answers. Every other row copies
    // nothing, which the shell says rather than copying something the reader
    // did not select.
    if (name === c.keys.copy) {
      const cap =
        current?.kind === "capability"
          ? s.capabilities.find((x) => x.id === current.id)
          : undefined;
      onCopy(
        cap &&
          (reporterOffer(s, c, cap.id)?.command ??
            capabilityOffer(cap, c)?.command),
      );
      return true;
    }
    if (name === c.keys.down || name === "down") {
      // The arrow moves the selection and nothing else. Without this the
      // focused scrollbox scrolls the viewport as well, and the row the reader
      // is standing on slides off the top edge.
      key.preventDefault();
      setSelected((i) => nextDown(items.length, i));
      return true;
    }
    if (name === c.keys.up || name === "up") {
      key.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
      return true;
    }
    if (name === c.keys.open) {
      openRow(selected);
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
  // A row's index is its position in `items`, looked up by its identity
  // rather than counted alongside it. A counter and a list can disagree, and a
  // filter that drops a row from the list while the render still counts it is
  // how they do: the highlight then sits on one row while Enter opens another.
  const placed = rowsById(items.map(settingKey));
  /**
   * One selectable Settings row, whichever kind it is, at its place in
   * `items`. The block is what the scroll reads for what is drawn under the
   * row, and the line is the row's own scroll target. `under` decides for
   * itself when it shows.
   */
  const settingRow = (
    item: SettingItem,
    line: (selected: boolean) => ReactNode,
    { under }: { under?: (selected: boolean) => ReactNode } = {},
  ) => {
    const key = settingKey(item);
    const i = placed(key);
    const chosen = i === selected;
    return (
      <ListRow
        key={key}
        id={`block-${i}`}
        lineId={`setting-${i}`}
        selected={chosen}
        onOpen={() => openRow(i)}
        under={under?.(chosen)}
      >
        {line(chosen)}
      </ListRow>
    );
  };
  const typedItems = (text: string): string[] | null => {
    try {
      const value = editValue([], text);
      return Array.isArray(value) ? value.map(String) : null;
    } catch {
      // A half-typed list is not a list yet; the box shows the text alone
      // until it parses again.
      return null;
    }
  };
  const valueRow = (key: string) => {
    const help = settingHelp(key);
    return settingRow(
      { kind: "setting", key },
      (chosen) => (
        <>
          {fit(settingLabel(key), 24)}
          {columnGap}
          <span attributes={chosen ? ui.none : ui.dim}>
            {safe(settingDisplay(key, settingValue(c, key), c))}
          </span>
        </>
      ),
      {
        under: (chosen) => (
          <>
            {!editing && !picking && chosen && help !== "" && (
              <Detail>
                <Line flexShrink={0} wrapMode="word" attributes={ui.dim}>
                  {help}
                </Line>
              </Detail>
            )}
            {editing && chosen && (
              <box
                flexDirection="column"
                flexShrink={0}
                border
                borderStyle="rounded"
                borderColor={ui.accent}
                title={` ${settingLabel(key)} · ${keyLabel(c.keys.open)} saves · ${keyLabel(c.keys.back)} cancels `}
              >
                <box height={1} flexShrink={0}>
                  <input
                    {...textInput}
                    focused
                    value={input}
                    onInput={setInput}
                    onSubmit={() => {
                      void commit(input);
                    }}
                  />
                </box>
                {/* A list on one line is a wall of quotes and commas. The same
                text, one item per line, is a list the reader can count. */}
                {editorKind(key, settingValue(c, key)) === "list" &&
                  typedItems(input)?.map((item, at) => (
                    <Line
                      // biome-ignore lint/suspicious/noArrayIndexKey: a list item is its position
                      key={`item-${at}`}
                      height={1}
                      flexShrink={0}
                      truncate
                      attributes={ui.dim}
                    >
                      {safe(`${at + 1}. ${item}`)}
                    </Line>
                  ))}
              </box>
            )}
            {picking && chosen && (
              <box
                flexDirection="column"
                flexShrink={0}
                border
                borderStyle="rounded"
                borderColor={ui.accent}
                title={` ${settingLabel(key)} · ${keyLabel(c.keys.open)} saves · ${keyLabel(c.keys.back)} cancels `}
              >
                {picking.map((option, at) => (
                  <box id={`choice-${at}`} key={option} flexShrink={0}>
                    <Row
                      selected={at === choice}
                      onOpen={() => {
                        setChoice(at);
                        void save(key, () => option);
                      }}
                    >
                      {option}
                    </Row>
                  </box>
                ))}
              </box>
            )}
          </>
        ),
      },
    );
  };
  return (
    <scrollbox
      ref={scroller}
      flexGrow={1}
      minHeight={0}
      scrollY
      focused={!editing && !picking}
      scrollbarOptions={scrollbar}
      contentOptions={{ flexShrink: 0 }}
    >
      <box flexDirection="column" flexShrink={0} paddingX={screenPad}>
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
              {...textInput}
              focused
              value={query}
              placeholder="name or label"
              onInput={filterTo}
              onSubmit={() => setSearching(false)}
            />
          </box>
        )}
        <Section
          title="Data sources"
          width={width}
          count={`${
            missing.length ? `${missing.length} not available` : "all available"
          }${
            sources.length
              ? ` · ${sources.length} ${sources.length === 1 ? "source" : "sources"} unreadable`
              : ""
          }`}
          marginTop={0}
        />
        {s.capabilities.map((cap) => {
          // The row less its marker, its dot, its disclosure and its label.
          const costWidth = width - 1 - 2 - 2 - 40;
          // One answer for the marker and the detail under it. A missing
          // source opens on selection; one that answered opens on Enter. The
          // cost is cut to the row with its mark and drawn whole in the
          // detail.
          const offer = capabilityOffer(cap, c);
          const install = reporterOffer(s, c, cap.id);
          const opened = (chosen: boolean) =>
            chosen && (!cap.available || openCap === cap.id);
          return settingRow(
            { kind: "capability", id: cap.id },
            (chosen) => (
              <>
                <span>{cap.available ? "● " : "○ "}</span>
                <Disclosure
                  open={opened(chosen)}
                  name={fit(capabilityLabels[cap.id], 40)}
                />
                <Ink
                  color={statusColor(
                    cap.available ? "available" : "not available",
                  )}
                >
                  {cap.available ? "available" : "not available"}
                </Ink>
                {!cap.available && (
                  <span attributes={ui.dim}>
                    {" "}
                    {fit(
                      safe(capabilityLoss(cap, c)),
                      Math.max(0, costWidth - 14),
                    )}
                  </span>
                )}
              </>
            ),
            {
              under: (chosen) =>
                opened(chosen) && (
                  <Detail>
                    <Field label="Gives" value={capabilityGives[cap.id]} wrap />
                    <Field
                      label="Read from"
                      value={cap.id === "tmux" ? "tmux list-panes" : cap.source}
                      wrap
                    />
                    {!cap.available && (
                      <Field
                        label="Reason"
                        value={capabilityReason(cap)}
                        wrap
                      />
                    )}
                    {cap.id === "tmux" ? (
                      <CommandOffer
                        sentence="Probe command"
                        command={`${cap.source}${cap.detail ? `: ${cap.detail}` : ""}`}
                        hint={`${keyLabel(c.keys.copy)} copies this source detail.`}
                      />
                    ) : (
                      cap.detail && (
                        <Field label="Detail" value={cap.detail} wrap />
                      )
                    )}
                    {/* What the reading costs is a second idea, not more of
                        the reason above it, so it starts after a blank row. */}
                    {!cap.available && (
                      <Line
                        flexShrink={0}
                        wrapMode="word"
                        marginTop={1}
                        attributes={ui.dim}
                      >
                        {safe(capabilityLoss(cap, c))}
                      </Line>
                    )}
                    {offer && (
                      <>
                        <Line
                          flexShrink={0}
                          wrapMode="word"
                          marginTop={1}
                          attributes={ui.dim}
                        >
                          {safe(offer.text)}
                        </Line>
                        <Line
                          flexShrink={0}
                          wrapMode="word"
                          fg={ui.accent}
                          marginTop={1}
                        >
                          {safe(offer.command)}
                        </Line>
                        <Line
                          flexShrink={0}
                          wrapMode="word"
                          attributes={ui.dim}
                          marginTop={1}
                        >
                          {keyLabel(c.keys.copy)} copies the command.
                        </Line>
                      </>
                    )}
                    {install && (
                      <CommandOffer
                        sentence={install.sentence}
                        command={install.command}
                        hint={`${keyLabel(c.keys.copy)} copies the command.`}
                      />
                    )}
                  </Detail>
                ),
            },
          );
        })}
        {!s.capabilities.length && (
          <Empty text="This sample was recorded before vsys probed its sources." />
        )}
        {items.some((item) => item.kind === "sources") &&
          settingRow(
            { kind: "sources" },
            () => (
              <>
                {/* Two columns stand in for the capability rows' own dot, so
                    this row's marker lines up with theirs rather than sitting
                    two columns to their left. */}
                {"  "}
                <Ink color={statusColor(sources.length ? "unread" : "OK")}>
                  {sources.length ? "unread " : "OK "}
                </Ink>
                <Disclosure
                  open={sourcesOpen}
                  name={
                    sources.length
                      ? "Sources vsys cannot read"
                      : "Every source was read"
                  }
                  count={
                    sources.length
                      ? `${sources.length} failed on the last sample`
                      : undefined
                  }
                />
              </>
            ),
            {
              under: () =>
                sourcesOpen && (
                  <Detail>
                    {sources.map(([source, n]) => (
                      <Line key={source} height={1} flexShrink={0} truncate>
                        {safe(fit(source, 48))}
                        <span attributes={ui.dim}>
                          {safe(
                            `${s.errors.find((e) => e.source === source)?.message ?? ""}${n > 1 ? ` (${n} reads)` : ""}`,
                          )}
                        </span>
                      </Line>
                    ))}
                  </Detail>
                ),
            },
          )}
        {items.some((item) => item.kind === "settingsFile") &&
          settingRow(
            { kind: "settingsFile" },
            (chosen) => (
              <>
                {fit(settingsFileInfo.label, 24)}
                {columnGap}
                <span attributes={chosen ? ui.none : ui.dim}>
                  {safe(settingsPath)}
                </span>
              </>
            ),
            {
              under: (chosen) =>
                chosen && (
                  <Detail>
                    {/* The row's own value cuts on a narrow terminal; naming
                        it again here, whole, is what every cut row's detail
                        does for what the row lost. */}
                    <Line flexShrink={0} wrapMode="word" attributes={ui.dim}>
                      {`${settingsFileInfo.help} ${safe(settingsPath)}`}
                    </Line>
                  </Detail>
                ),
            },
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
                  {keys.map(valueRow)}
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
