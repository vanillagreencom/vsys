interface Stroke {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
  hyper?: boolean;
}
const modifiers = ["ctrl", "alt", "shift", "super", "hyper"] as const;

/** Settings chords and input events use the same modifier order. */
export function keyName(key: Stroke): string {
  const active = {
    ctrl: key.ctrl,
    alt: key.meta || key.option,
    shift: key.shift,
    super: key.super,
    hyper: key.hyper,
  };
  return [...modifiers.filter((m) => active[m]), key.name].join("+");
}
export function normalizeKey(value: string): string {
  const match = value.match(/^((?:(?:ctrl|alt|shift|super|hyper)\+)*)(.+)$/u);
  if (!match) throw new Error(`Invalid keybinding: ${value}`);
  const prefix = match[1] ? match[1].slice(0, -1).split("+") : [];
  let name = match[2];
  if ([...name].length !== 1 && !/^[a-z][a-z0-9]*$/.test(name))
    throw new Error(`Invalid key name: ${name}`);
  if (/^[A-Z]$/.test(name)) {
    name = name.toLowerCase();
    if (!prefix.includes("shift")) prefix.push("shift");
  }
  if (new Set(prefix).size !== prefix.length)
    throw new Error("Repeated key modifier");
  return keyName({
    name,
    ctrl: prefix.includes("ctrl"),
    meta: prefix.includes("alt"),
    shift: prefix.includes("shift"),
    super: prefix.includes("super"),
    hyper: prefix.includes("hyper"),
  });
}
