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
 * A list's selection, resolved against the rows a render draws and recorded
 * as resolved. Every screen whose rows can move under a sample reads this one
 * rule rather than writing its own.
 *
 * Resolving alone is not enough for a list that re-orders. Where the chosen
 * item has gone, the fallback is a row number, and an arrival can land on
 * exactly that number: the list has a row there, so nothing looks wrong, and
 * the highlight moves to the newcomer. Writing the resolved row back makes the
 * fallback a choice, the way a key press is one. Recording costs a list that
 * only prepends nothing, so no screen has to decide which kind its list is.
 *
 * The record is an effect, and a screen that also moves the selection from an
 * effect must declare that one after this hook: this effect runs first in the
 * pass, so the screen's effect wins it. Declared the other way, each writes
 * its own row on every pass and the render never settles.
 */
export function useSelection(
  ids: readonly string[],
  selection: Selection,
  onSelect: (next: Selection) => void,
): { selected: number; choose: (index: number) => void } {
  const selected = resolvedRow(ids, selection);
  const id = selected < 0 ? null : ids[selected];
  // What `choose` reads, kept current so that `choose` itself never changes:
  // a screen's effect that moves the selection lists it as a dependency, and
  // a new one on every render would run that effect on every render.
  const latest = useRef({ ids, onSelect });
  latest.current = { ids, onSelect };
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
    onSelect({ index, id: ids[index] ?? null });
  }, []);
  return { selected, choose };
}
