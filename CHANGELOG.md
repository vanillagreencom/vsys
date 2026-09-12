# Changelog

Notable changes, per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries are written when a change lands, not batched at release. Write each one at 200 characters or fewer: the outcome for a person using vsys, a migration note inline on a **Breaking:** change, and credit (`— thanks @name`) when the change came from an outside contributor.

## [Unreleased]

## [0.9.0] - 2026-09-11

### Added

- Arch Linux users can install `vsys` from the AUR, or `vsys-git` to track the main branch.
- Install vsys without a clone: one `curl … | bash` line from the README puts a verified standalone binary in `~/.local/bin`. A download that fails its checksum is not installed.

### Changed

- **Breaking:** the program is now `vsys`. Move `~/.config/vsys-view/` to `~/.config/vsys/`, move `~/.local/state/vsys-view/` to `~/.local/state/vsys/`, and repoint `sqlitePath` in your config.
