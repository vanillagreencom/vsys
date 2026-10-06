# The installer writes only marked files, and a package enables nothing

Read before changing `vsys warden install`, `warden/install`, the unit templates, or what a package ships beside the binary.

## The approach

`vsys warden install` writes `agent-warden.service`, `agent-warden.timer` and `agents.slice` into the user's systemd unit directory, copies the shipped agent-tool data into the vsys data directory, reloads the user manager and enables the timer. Every unit it writes starts with the marker in `warden/install`, and the service unit records the data file's hash. The vsys and vsys-git packages, the release archive and `install.sh` ship the warden tree under `lib/vsys/` through `packaging/vsys-runtime-files.txt`, and none of them installs a user unit or enables anything. `src/warden.ts` finds the tree beside the source, beside the installed binary, or below an extracted archive.

## Why

The owner workstation stows these files from dotfiles. An installer that wrote through a symlink would edit another tool's files, and a package preset would turn automatic correction on as package policy where it is a user's choice.

## Rules

- Do refuse the whole install when any target is a symlink or an unmarked file, when a unit or data directory is itself a symlink, or when a target cannot be read. A marked file is ours and can be rewritten. `warden/install_test.py` covers foreign, unreadable and linked targets.
- Do overwrite the copied data file only when it is absent or its hash matches one recorded in the marked service unit, and record both the new and the installed hash during an upgrade so an interrupted write can be retried.
- Do fill `@WARDEN_DIR@` in the service template with the resolved tree, escaping `%` and quoting whitespace, and refuse when `agent-warden` is not executable.
- Do make `uninstall` remove only marked files and a data copy whose hash matches, stop only a marked service, and leave `agents.slice` and every running scope alone.
- Do make `status` read-only, and fail it on any read that could not be taken.
- Do add a shipped file to `packaging/vsys-runtime-files.txt`. `scripts/package_file_list_check.py` holds the payload, the modes, the reporter rows and the rule that no package installs or enables a user unit, and `scripts/package_file_list_check_test.py` runs each PKGBUILD's `package()`.
- Never write, overwrite or remove the local overlay `~/.config/vsys/agent-tools.json`.
- Never install under `/usr/lib/systemd/user`, and never preset or enable a unit from a package.
- Never strip the compiled binary in a package. Stripping removes Bun's appended bundle, so both PKGBUILDs set `!strip` and `!debug`.

## The canonical example

The marker check in `warden/install`: read the first line, compare it to `MARKER`, and treat anything else as foreign. Copy it for any file the installer may own.

## Revisit when

Packaging generates per-distribution units, or systemd offers a user-unit ownership record the marker duplicates.

## Not governed

What the warden does once it runs: [warden.md](warden.md). The root-side reporters the same payload ships: [reporters.md](reporters.md).
