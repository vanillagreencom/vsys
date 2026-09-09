import { type ColorInput, RGBA, TextAttributes } from "@opentui/core";
import type { Config } from "../config/config";

export interface Palette {
  bg: ColorInput;
  fg: ColorInput;
  danger: ColorInput;
  warning: ColorInput;
  selected?: ColorInput;
  selection: number;
}
/** Default and indexed colour intents preserve the terminal's own palette. */
export function themePalette(theme: Config["theme"]): Palette {
  if (theme === "terminal")
    return {
      bg: RGBA.defaultBackground(),
      fg: RGBA.defaultForeground(),
      danger: RGBA.fromIndex(1),
      warning: RGBA.fromIndex(3),
      selection: TextAttributes.INVERSE,
    };
  if (theme === "light")
    return {
      bg: "#f5f5f5",
      fg: "#202020",
      danger: "#b42318",
      warning: "#8a5a00",
      selected: "#c8ddfa",
      selection: 0,
    };
  return {
    bg: "#171b22",
    fg: "#dce2eb",
    danger: "#ff6b6b",
    warning: "#f2c14e",
    selected: "#283b56",
    selection: 0,
  };
}
