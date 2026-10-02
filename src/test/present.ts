/**
 * The value an indexed read in a test found, or a failure naming what was
 * missing. Under `noUncheckedIndexedAccess` a read such as `rows[2]` may be
 * undefined; a test that depends on it being there fails here, at the read,
 * rather than at a later property access with no name attached.
 */
export function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}, found nothing`);
  return value;
}
