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
| `build` | `ubuntu-latest`, `ubuntu-24.04-arm` | `vsys-<tag>-linux-<arch>.tar.gz`, each holding `vsys`, `LICENSE` and `README.md` |
| `release` | `ubuntu-latest` | A GitHub Release carrying both archives and `SHA256SUMS` |
| `aur` | `ubuntu-latest` | The `vsys` AUR package, updated to the new `pkgver` and checksums |

`install.sh` reads the latest release tag, downloads the archive for the running architecture, checks it against `SHA256SUMS`, and refuses to install when either is missing.

## Secrets

| Name | Use |
| --- | --- |
| `AUR_SSH_PRIVATE_KEY` | Pushes to `ssh://aur@aur.archlinux.org/vsys.git` and `/vsys-git.git` |

## AUR packages

`packaging/vsys/PKGBUILD` installs the released binary. Its `pkgver` and `sha256sums_*` are rewritten by the release job.

`packaging/vsys-git/PKGBUILD` builds from `main` with Bun. Its `pkgver()` derives a version from `git describe`, so it needs no edit per release. `.github/workflows/aur-git.yml` pushes it when `main` moves.

Both AUR packages are created by their first push, so bootstrap each one with the same script CI runs. It pins the version, fills in the published checksums, and refuses to push a recipe that still carries a `SKIP` placeholder.

```sh
export AUR_SSH_PRIVATE_KEY="$(cat ~/.ssh/vgs_aur_rsa)"
packaging/publish-aur.sh vsys-git       # any time
packaging/publish-aur.sh vsys 0.9.0     # only once the release is published
```

Bootstrap `vsys` only after its GitHub Release exists, because the script reads `SHA256SUMS` from it.
