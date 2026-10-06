# Releasing vsys

## Procedure

1. From a clean index and working tree, set `COMMIT_GUARDS_CHANGELOG_COLLATE=1` and run `.agents/skills/commit-guards/scripts/changelog-entries --collate`. It folds the `changelog.d` fragments into the `[Unreleased]` section of `CHANGELOG.md` and deletes them. A nonzero exit halts the release.
2. Set `version` in `package.json` to the tag without its leading `v`.
3. Move the collated entries under a new `## [<version>] - <date>` heading in `CHANGELOG.md`, leaving an empty `## [Unreleased]` above it. Confirm every breaking change carries its **Breaking** call-out and its migration note.
4. Commit with `COMMIT_GUARDS_CHANGELOG_COLLATE=1` set. That declaration is what lets the `commit-msg` lane count the `CHANGELOG.md` change as the entry the version bump owes.
5. Tag `v<version>` and push the tag.

## What the tag builds

`.github/workflows/release.yml` runs on a `v*` tag.

| Job | Runner | Output |
| --- | --- | --- |
| `build` | `ubuntu-latest`, `ubuntu-24.04-arm` | `vsys-<tag>-linux-<arch>.tar.gz`, each holding `vsys`, `LICENSE`, `README.md` and `lib/` |
| `reporter` | `ubuntu-latest` | `scrub-reporter.sha256` and `smart-reporter.sha256`, uploaded to the release and folded into `SHA256SUMS` |
| `release` | `ubuntu-latest` | A GitHub Release carrying both archives and `SHA256SUMS` |
| `aur` | `ubuntu-latest` | The `vsys` AUR package, updated to the new `pkgver` and checksums |

`install.sh` reads the latest release tag, downloads the archive for the running architecture, checks it against `SHA256SUMS`, and refuses to install when either is missing. It installs the warden tree beside the binary at `<prefix>/lib/vsys/warden`, so `vsys warden install` can find the installer.

| Archive path | Use |
| --- | --- |
| `vsys` | Dashboard binary. |
| `LICENSE` | License text for packages and archives. |
| `README.md` | User documentation for packages and archives. |
| `lib/vsys/warden/` | Warden installer, launcher scripts and systemd user-unit templates. |
| `lib/vsys/data/agent-tools.json` | Shared agent-tool data for the dashboard and warden. |
| `lib/vsys/scripts/scrub-reporter/vsys-scrub-report` | The scrub reporter, which the packaged drop-in runs as root after each Btrfs scrub. |
| `lib/systemd/system/btrfs-scrub@.service.d/vsys-report.conf` | The drop-in that runs it. Only the packages install it; `install.sh` does not. |
| `lib/tmpfiles.d/vsys-scrub.conf` | The tmpfiles line that creates `/var/lib/btrfs-scrub`. Only the packages install it. |

## Secrets

| Name | Use |
| --- | --- |
| `AUR_SSH_PRIVATE_KEY` | The AUR key's contents, used by CI to push to `ssh://aur@aur.archlinux.org/vsys.git` and `/vsys-git.git` |

Running the publish script by hand takes `AUR_SSH_KEY_FILE` instead, the path to a key already on disk, so no private key is copied anywhere. The script verifies the AUR against the host keys pinned in `packaging/aur-known-hosts` and reads and writes nothing under `~/.ssh`.

## AUR packages

`packaging/vsys/PKGBUILD` installs the released binary and the `lib/` tree from the release archive. Its `pkgver` and `sha256sums_*` are rewritten by the release job.

`packaging/vsys-git/PKGBUILD` builds from `main` with Bun and stages the same `lib/` files from the checkout. Its `pkgver()` derives a version from `git describe`, so it needs no edit per release. `.github/workflows/aur-git.yml` pushes it when `main` or the warden files move.

Both AUR packages depend on `python`, `systemd` and `systemd-libs`, because the warden uses Python and `libsystemd.so.0`, and vsys and the warden run the systemd tools. Feature programs are optional dependencies; [warden install](architecture/warden-install.md) lists them. They install no systemd user units and enable no timer. They do install the scrub reporter's `btrfs-scrub@.service` drop-in and tmpfiles line, which act only when a `btrfs-scrub@` timer the reader enabled runs a scrub. The user runs `vsys warden install` to write units into the user's config directory.

Both AUR packages disable makepkg strip and debug splitting, because stripping a Bun compiled binary removes its appended program bundle.

Both AUR packages are created by their first push, so bootstrap each one with the same script CI runs. It pins the version, fills in the published checksums, and refuses to push a recipe that still carries a `SKIP` placeholder.

```sh
export AUR_SSH_KEY_FILE=~/.ssh/vgs_aur_rsa
packaging/publish-aur.sh vsys-git       # any time
packaging/publish-aur.sh vsys 0.9.0     # only once the release is published
```

Bootstrap `vsys` only after its GitHub Release exists, because the script reads `SHA256SUMS` from it.
