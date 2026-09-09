/** Strings are edited directly; TOML preserves commas and escapes in lists. */
export function settingText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
export function settingValue(before: unknown, text: string): unknown {
  return typeof before === "string"
    ? text
    : (Bun.TOML.parse(`value = ${text}`) as Record<string, unknown>).value;
}
