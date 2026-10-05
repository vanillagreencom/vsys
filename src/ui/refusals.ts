import { ConfigError, type ConfigRefusal } from "../config/config";
import { ArgumentError, type ArgumentRefusal } from "../main";
import { SettingsError, type SettingsRefusal } from "../runtime";
import { ArchiveError, type ArchiveRefusal } from "../store/archive";
import { WardenError, type WardenRefusal } from "../warden";

/**
 * What the reader is told about a failure. A typed refusal carries only its
 * kind and identifiers, so its sentence is written here; any other error
 * speaks in its own message.
 */
export function errorText(error: unknown): string {
  if (error instanceof ConfigError)
    return configText(error.refusal, error.cause);
  if (error instanceof SettingsError) return settingsText(error.refusal);
  if (error instanceof ArchiveError) return archiveText(error.refusal);
  if (error instanceof WardenError) return wardenText(error.refusal);
  if (error instanceof ArgumentError) return argumentText(error.refusal);
  return error instanceof Error ? error.message : String(error);
}

function configText(refusal: ConfigRefusal, cause: unknown): string {
  switch (refusal.kind) {
    case "keybinding-clash":
      return `Keybindings must be unique: ${refusal.clashes
        .map(
          ({ key, actions }) =>
            `${key} is bound to ${actions.slice(0, -1).join(", ")} and ${actions.at(-1)}`,
        )
        .join("; ")}`;
    case "pressure-order":
      return "Pressure thresholds must increase from amber to red and cannot exceed 100 percent";
    case "multi-line-value":
      return `Settings save cannot edit ${refusal.key}: its line in config.toml holds more than this one line's value. Edit ${refusal.key} by hand in config.toml to one line, then Settings can save it again.`;
    case "untouched-value-changed":
      return `Settings save would change ${refusal.key}, which this save never touched: refusing to write a config.toml that moved content it did not mean to change`;
    case "save-unloadable":
      return `Settings save produced a config.toml this project's own loader refuses: ${errorText(cause)}`;
  }
}

function settingsText(refusal: SettingsRefusal): string {
  switch (refusal.kind) {
    case "pinned-omits-shipped":
      return `Pinned agentTools omits shipped agent tools: ${refusal.missing.join(", ")}. Edit agentTools in config.toml, or remove it there to use the shared list.`;
    case "overlay-changed":
      return "Agent-tools rollback skipped because the overlay changed after this save";
    case "rollback-skipped":
      return "Config save failed and agent-tools rollback skipped because the overlay changed after this save";
    case "rollback-failed":
      return "Config save failed and agent-tools rollback failed";
  }
}

function archiveText(refusal: ArchiveRefusal): string {
  switch (refusal.kind) {
    case "invalid-column":
      return `Invalid archived column: ${refusal.table}.${refusal.field}`;
    case "short-column":
      return `Archived column ${refusal.table}.${refusal.field} has no row ${refusal.row}`;
    case "missing-line":
      return `Archive checkpoint has no line ${refusal.line}`;
    case "over-budget":
      return "A history checkpoint exceeds the memory budget";
  }
}

function wardenText(refusal: WardenRefusal): string {
  switch (refusal.kind) {
    case "installer-not-found":
      return `vsys warden installer not found; tried ${refusal.tried.join(", ")}`;
  }
}

function argumentText(refusal: ArgumentRefusal): string {
  switch (refusal.kind) {
    case "needs-once":
      return "--summary requires --once";
  }
}
