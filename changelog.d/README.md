# Changelog fragments

Write each change a person using vsys would notice in `changelog.d/<section>/<name>.md`. State its outcome, not the implementation. Put migration instructions in a breaking-change entry.

- Fragment sections, content shape, and length limits are defined in [the changelog check](../.agents/skills/commit-guards/CHECKS.md#changelog-entries).
- Follow [the release procedure](../docs/RELEASING.md) to combine accepted fragments into the pending release section of `CHANGELOG.md`. The collator validates the destination before writing and deletes the fragments after replacement.
- Ordinary checks permit wording and heading edits in the combined release notes.
- The `commit-msg` lane requires a fragment for changes under `src/`, `scripts/`, `packaging/` and `install.sh`. `[no-changelog]` waives it when the change has no effect a person using vsys would see. A record change counts under the release declaration.
