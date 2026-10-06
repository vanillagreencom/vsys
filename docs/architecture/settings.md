# A settings change replaces only what reads it

Read before adding a setting, changing what a settings save writes, or changing what a settings change rebuilds.

## The approach

Settings are validated before they reach a running dashboard. `collectionKeys` in `src/collect/settings.ts` declares what collection reads; a change to one of them builds a new collector, and a change to anything else keeps it. `Session` in `src/runtime.ts` owns the one scheduler, so no sample overlaps a settings change. A save writes only what differs from the layered defaults ([D006](../decisions/D006-settings-save-writes-only-changed-keys.md)), and a Settings edit to the agent tools goes to the shared overlay. A capability is a system interface a reading needs, probed once at start; the tmux server, the agent slice, the scrub and drive report directories and io-stat are re-read each sample.

## Why

Rebuilding the collector discards the counters and alert state a sample compares against, so a display setting that rebuilt it would reset every rate on the screen. A save that wrote the resolved configuration froze derived defaults as user intent, and left the dashboard on an agent list the warden no longer shared.

## Rules

- Do declare a new collection setting in `collectionKeys`. `CollectionConfig` picks those keys, so a collection function reading an undeclared setting fails the type check.
- Do keep a display setting and a notification rule out of `collectionKeys`. `src/runtime.test.ts` checks that each leaves the collector in place.
- Do hand a replaced collector its predecessor's build cache reader, kernel log cursor and finished-scrub memory, so readings measured since vsys started survive. `src/runtime.test.ts` and `src/collect/collector.test.ts` check the handover.
- Do give every host-specific name a systemd user-session default, and ship write mode off. `src/config/config.test.ts` checks both.
- Do give every setting one entry in `settingInfo` in `src/ui/settings.ts` and one group. `src/ui/settings.test.ts` and `src/ui/settings-screen.test.tsx` derive the expected sets from the defaults.
- Do resolve an XDG base directory through `xdgHome()` in `src/config/xdg.ts`. The overlay stays at `~/.config/vsys/agent-tools.json` whatever `XDG_CONFIG_HOME` holds, because the warden reads it there.
- Do offer a missing capability its line through `capabilityOffer()` and a reporter install through `reporterOffer()`, both in `src/ui/settings.ts`. The line is text to copy; vsys never runs it.
- Never save a derived default into `config.toml`, and never remove a shipped name from the overlay. `src/runtime.test.ts` checks pinned and unpinned saves.
- Never let a failed settings write leave the active source or history unusable. `src/runtime.test.ts` checks replacement failure.

## The canonical example

`scratchDutyPercent`: declared in `collectionKeys`, validated with its range in `src/config/config.ts`, one `settingInfo` entry with its unit, and read only through `CollectionConfig`. Copy that for a new collection setting.

## Revisit when

The shared agent-tool schema can record removals ([D006](../decisions/D006-settings-save-writes-only-changed-keys.md)), or a reading needs a capability re-probed on a schedule other than every sample.

## Not governed

What the agent slice probe decides: [lanes.md](lanes.md). What a missing capability costs on the screen: [unknown-readings.md](unknown-readings.md).
