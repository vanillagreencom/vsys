# Settings and the runtime

Covers: src/config/ src/collect/settings.ts src/collect/capabilities.ts src/runtime.ts src/ui/settings-screen.tsx src/ui/settings.ts

Settings are validated before they reach a running dashboard. The runtime replaces the collector, the history store or neither, depending on which settings changed. A capability is a system interface a reading needs, probed once at start, except the two re-read each sample.

## Boundaries

- Every host-specific name is configuration: the agent and desktop slices, the excluded argv patterns, the confinement cap markers, the compiler, linker and cache names, and the environment variables carrying the account, the pane, the window title and the build token pool.
- `collectionKeys` in `src/collect/settings.ts` is the only declaration of what collection reads, and `CollectionConfig` is the type every collection entry point takes. Reading an undeclared setting fails the type check rather than leaving the collector stale.
- Display settings and notification rules are deliberately not collection settings, because rebuilding the collector discards the counters and alert state a sample compares against.
- `Session` in `src/runtime.ts` owns one scheduler for collection and settings changes, so samples never overlap and a failed settings write leaves the active source and history usable.
- `choices` in `src/config/config.ts` is the one table both the picker and `validate` read, so a value a reader can pick is a value that saves.
- `saveConfig()` writes only settings that differ from the layered defaults. `Session` reloads the current agent-tool overlay before a Settings save, and rebases agent-program edits on that current overlay. It refuses an agent-program edit when a hand-written `config.toml` pin omits a shipped name, because the overlay cannot encode removals. A failed config save rolls back that overlay only when it still matches the body this save wrote. A diverging hand-written `config.toml` pin remains a dashboard override. D006 records the save rule. `sameValue()` in `src/config/config.ts` is the one judgement of whether a setting holds its default, and a save writes only the settings that differ. Storage reads the same judgement: a scratch list equal to the shipped list is the default, whether `config.toml` omits it or pins it unchanged, and any other list is the reader's, as [storage](storage.md) states.
- `settingInfo` in `src/ui/settings.ts` holds one entry per setting: the label that fits the list column, the sentence the drill-down shows, and the unit a stored number is written in. The list shows the value in that unit; the editor opens the stored value.
- The capability probe reads each interface once at start, so an interface cannot change between ticks. Whether a tmux server answers and whether the agent slice exists are the exceptions: both are re-read each sample, because this is a dashboard for agents that start after it. [lanes.md](lanes.md) owns what the agent slice probe decides.
- `capabilityOffer()` in `src/ui/settings.ts` is the one place a missing capability offers a line to supply it. An absent agent slice offers `systemctl --user set-property` with the memory limits of the warden's slice template, `warden/systemd/agents.slice`. The line is text to copy; vsys never runs it.
- vsys reads system state unless write mode is on. A remediation command is text to copy; write mode additionally lets a confirmed Freeze, Thaw or Stop reach the lane's scope.

## Invariants

1. Every host-specific name ships a systemd user-session default, and write mode ships off. `src/config/config.test.ts` checks both.
2. An unknown setting, a wrong type, a duplicate list entry, a relative path where an absolute one is required and a threshold out of range each stop loading. `src/config/config.test.ts` checks invalid settings and malformed TOML.
3. Saving settings through a file link preserves the link and updates its target. `src/config/config.test.ts` checks the target contents.
4. A saved collection setting rebuilds the source before the next sample, and a display setting or a notification rule does not. `src/runtime.test.ts` checks all three.
5. A settings change waits for the in-flight source before sampling again, and hands the running source to its replacement. `src/runtime.test.ts` checks both.
6. A failed settings write leaves the active history and source usable. `src/runtime.test.ts` checks replacement failure.
7. A missing capability carries its source and a cause following what the probe met, so an unreadable or unparsable source is never called a missing interface and a tmux without a server is never called a missing tmux. `src/collect/capabilities.test.ts` checks the diagnoses; `src/ui/settings.test.ts` checks the words.
8. Every sample carries the capabilities probed when vsys started, and the agent slice as this sample found it. `src/collect/capabilities.test.ts` checks both, including a slice that appears after vsys starts.
9. Every stored setting has a label, a sentence and, where it stores a number, a unit, and no label is wider than its column. `src/ui/settings.test.ts` derives the expected set from the defaults.
10. A stored value reads in the reader's unit rather than the stored one, and an interval under a second reads as itself rather than as zero. `src/ui/settings.test.ts` checks both.
11. Every setting sits in exactly one group, and no group names a stranger. `src/ui/settings-screen.test.tsx` derives the expected set from the defaults.
12. The Settings filter matches the stored name and the label the reader sees, so either spelling finds a row. `src/ui/settings-screen.test.tsx` checks a query only the labels carry.
13. What Enter does follows from the value the setting holds, decided once by `editorKind`. A boolean toggles with no editor, an enum offers its words, and everything else opens the text box. `src/ui/settings-screen.test.tsx` checks each kind from the keyboard.
14. A value the validator refuses is reported and never saved, a picker keeps its choice on the screen however long its list, search cannot open behind a picker, and a query leaves selected the row it matched or none. `src/ui/settings-screen.test.tsx` checks all four.
15. Settings reports the running program while a past sample is pinned, because the probe describes the program rather than the sample. `src/ui/settings-screen.test.tsx` checks it.
16. Write mode off refuses every lane action; on, each stands behind a confirmation naming the scope. A pinned sample refuses one whatever write mode says, because its scope name may belong to another lane by now. `src/ui/agent.test.tsx` checks all four.
17. A Settings save writes only changed keys, and an agent-program edit writes `~/.config/vsys/agent-tools.json` without pinning `agentTools` in `config.toml`. A pin that omits a shipped name refuses agent-program edits until the reader edits or removes the pin. A failed config save rolls back only the overlay body it wrote, so a newer overlay stays in place. `src/config/config.test.ts` checks the saved TOML and migration cases; `src/runtime.test.ts` checks stale overlay saves, pinned and unpinned Settings edits, unrelated saves over a diverging pin, pinned removal refusal, rollback after a config write failure, skipped rollback after a newer overlay and warden loader parity.
18. An absent agent slice, and nothing else, offers a line that limits one, with the limits the warden template sets, and the copy key copies it from that row alone. `src/ui/settings.test.ts` reads the template; `src/ui/settings-screen.test.tsx` copies from the row and from another row.
