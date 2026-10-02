import { useCallback, useEffect, useRef } from "react";

/**
 * What a reader chose on a list: the row they moved to, and the item that row
 * named. A row number alone cannot survive a live list, because an arrival or
 * a departure above the row moves every row below it.
 */
export interface Selection {
  index: number;
  id: string | null;
}
/** The selection before the reader has chosen: the first row, naming nothing. */
export const firstRow: Selection = { index: 0, id: null };

/**
 * The row `selection` stands on among `ids`, the identities of the rows this
 * render draws, in order: the chosen item wherever it has moved to, and where
 * it has gone, the nearest row that exists. With no rows it is -1, which names
 * no row and focuses no region.
 */
export function resolvedRow(
  ids: readonly string[],
  selection: Selection,
): number {
  const found = selection.id === null ? -1 : ids.indexOf(selection.id);
  if (found >= 0) return found;
  return Math.min(Math.max(0, selection.index), ids.length - 1);
}

/**
 * `ids` with every repeat told apart by its place among the rows sharing its
 * identity: the second `a` is `a#2`. Two rows under one identity would resolve
 * to the first of them whichever the reader chose, and a list can draw two:
 * two mounts stacked at one path are two Storage rows with one path.
 */
function distinctIds(ids: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return ids.map((id) => {
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n === 1 ? id : `${id}#${n}`;
  });
}

/**
 * The row each identity is drawn at, for a screen that draws its rows in an
 * order of its own and looks each one up. A row the list does not hold, or an
 * identity two rows share, is a screen drawing something its selection cannot
 * reach, so both throw rather than draw a row no key can land on.
 */
export function rowsById(ids: readonly string[]): (id: string) => number {
  const at = new Map<string, number>();
  for (const [row, id] of ids.entries()) {
    if (at.has(id)) throw new Error(`Two rows share one identity: ${id}`);
    at.set(id, row);
  }
  return (id) => {
    const row = at.get(id);
    if (row === undefined)
      throw new Error(`A row its selection does not list: ${id}`);
    return row;
  };
}

/**
 * A list's selection, resolved against the rows a render draws and recorded
 * as resolved. Every screen whose rows can move under a sample reads this one
 * rule rather than writing its own.
 *
 * Resolving alone is not enough for a list that re-orders. Where the chosen
 * item has gone, the fallback is a row number, and an arrival can land on
 * exactly that number: the list has a row there, so nothing looks wrong, and
 * the highlight moves to the newcomer. Writing the resolved row back makes the
 * fallback a choice, the way a key press is one. Every screen records, so
 * none has to decide which kind its list is. The cost: the gone item is
 * forgotten once the fallback is written. A list the reader's own key shrinks
 * and restores, or a top list an item leaves for one sample, comes back on the
 * fallback row rather than on the item.
 *
 * The record is an effect, and a screen that also moves the selection from an
 * effect must declare that one after this hook: this effect runs first in the
 * pass, so the screen's effect wins it. Declared the other way, each writes
 * its own row on every pass and the render never settles.
 */
export function useSelection(
  keys: readonly string[],
  selection: Selection,
  onSelect: (next: Selection) => void,
): {
  /** One identity per row, every repeat told apart: what a row is keyed by. */
  ids: string[];
  selected: number;
  choose: (index: number) => void;
  move: (step: (from: number) => number) => void;
} {
  const ids = distinctIds(keys);
  const selected = resolvedRow(ids, selection);
  const id = ids[selected] ?? null;
  // What `choose` and `move` read, kept current so that neither ever changes:
  // a screen's effect that moves the selection lists it as a dependency, and
  // a new one on every render would run that effect on every render. `at` is
  // the row last chosen, which a render resets to the row it drew.
  const latest = useRef({ ids, onSelect, at: selected });
  latest.current = { ids, onSelect, at: selected };
  useEffect(() => {
    // An empty list records nothing, so the choice is kept for the rows that
    // arrive. Each pass that moved nothing writes nothing, which is how the
    // record settles.
    if (id === null) return;
    if (selection.index !== selected || selection.id !== id)
      onSelect({ index: selected, id });
  });
  // The row and the item it names are recorded together, so no caller can
  // record a row number without saying which item it points at.
  const choose = useCallback((index: number) => {
    const { ids, onSelect } = latest.current;
    latest.current.at = index;
    onSelect({ index, id: ids[index] ?? null });
  }, []);
  // A step from the row last chosen rather than the row last drawn. The
  // terminal delivers every key in one read before the screen renders again,
  // so two arrows pressed together step twice only if the second starts where
  // the first landed.
  const move = useCallback(
    (step: (from: number) => number) => choose(step(latest.current.at)),
    [choose],
  );
  return { ids, selected, choose, move };
}
