import { useEffect, useRef, useState } from "react";

/**
 * What a held list does with a row that was not drawn when its order was
 * held. A top list leaves it out: the reader held a ranking's rows, and a row
 * that climbs into the ranking would push a held one down. A full list appends
 * it after the held rows: a list that claims every row cannot hide a live one.
 */
export type Newcomers = "append" | "leave out";

/**
 * The rows of one list in the order a reader held, or in the live order while
 * nothing is held. Holding the order is not freezing the data: each held id is
 * looked up in the current sample, so the readings keep moving while the rows
 * stay where the reader left them, and a row whose id is gone has ended and
 * drops out. Held ids are looked up in `pool`, which a top list sets to every
 * row there is, because a held row that has fallen below the cut is still held.
 */
export function heldOrder<T>(
  live: readonly T[],
  held: readonly string[] | undefined,
  id: (row: T) => string,
  newcomers: Newcomers,
  pool: readonly T[] = live,
): T[] {
  if (held === undefined) return [...live];
  const byId = new Map(pool.map((row) => [id(row), row]));
  const kept = held.flatMap((key) => {
    const row = byId.get(key);
    return row === undefined ? [] : [row];
  });
  if (newcomers === "leave out") return kept;
  const seen = new Set(held);
  return [...kept, ...live.filter((row) => !seen.has(id(row)))];
}

/** What a list's heading says while its order is held. */
export const heldLabel = "order held";
/** A heading's count, followed by the held marker while the order is held. */
export function heldCount(
  count: number | string | undefined,
  held: boolean,
): number | string | undefined {
  if (!held) return count;
  return count === undefined ? heldLabel : `${count} · ${heldLabel}`;
}

/** Each list's ids in order, by the name its screen gives the list. */
type Orders = Record<string, string[]>;
const sameOrders = (a: Orders, b: Orders): boolean =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(
    ([name, ids]) =>
      Object.hasOwn(b, name) &&
      b[name].length === ids.length &&
      ids.every((key, i) => b[name][i] === key),
  );

/**
 * A screen's hold on the order of its lists. One key holds every list on the
 * screen and the same key lets go; a key that asks for an order lets go too,
 * through `release`. The hold is the screen's own state, so it ends when the
 * screen unmounts and nobody comes back to a stale order they forgot.
 */
export interface HeldOrder {
  held: boolean;
  /**
   * The ids list `name` keeps, in order, for `heldOrder`. Undefined while
   * nothing is held, and for a list first drawn after the hold began, which
   * holds from that first draw.
   */
  kept(name: string): string[] | undefined;
  /**
   * Records the ids list `name` draws in this render. A hold keeps each list
   * as last drawn: pressing the key keeps the rows the reader was looking at,
   * and while held an ended row leaves the kept order and an appended row
   * joins it, so an appended row stays where it first appeared. Every list the
   * hold covers records here on every render, held or not.
   */
  drew(name: string, ids: string[]): void;
  toggle(): void;
  release(): void;
}
export function useHeldOrder(): HeldOrder {
  const [held, setHeld] = useState<Orders | null>(null);
  const drawn: Orders = {};
  // What the last committed render drew, which is what was on screen when a
  // key arrived.
  const last = useRef<Orders>({});
  useEffect(() => {
    last.current = drawn;
    // Drawing a kept order draws that order again, so this settles in one
    // pass.
    if (held !== null && !sameOrders(held, drawn)) setHeld(drawn);
  });
  return {
    held: held !== null,
    kept: (name) =>
      held !== null && Object.hasOwn(held, name) ? held[name] : undefined,
    drew: (name, ids) => {
      drawn[name] = ids;
    },
    toggle: () =>
      setHeld((current) => (current === null ? last.current : null)),
    release: () => setHeld(null),
  };
}
