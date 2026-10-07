# vsys development

Bun at the version in `.bun-version`, on a Linux host with cgroup v2. The repository ships that Bun as a dependency; where the system Bun differs, prefix a command with `PATH="$PWD/node_modules/.bin:$PATH"`.

## Run

```sh
bun install
bun run start                      # the dashboard against this checkout; needs a TTY
bun src/main.ts --once             # one JSON snapshot, no terminal; exit 2 on source errors
bun src/main.ts --once --summary   # the verdict JSON scripts read
bun src/main.ts --once --markdown  # the snapshot as Markdown
bun src/main.ts --config PATH      # another settings file
```

## Test

```sh
python3 scripts/ci.py              # the whole check contract; run before claiming a change green
bun test src/                      # the application suites, from the repository root
python3 -m unittest discover -s scripts -p '*_test.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s warden -p '*_test.py'
```

`bun test` runs from the repository root, where `bunfig.toml` preloads the warning gate in `src/test/warnings.ts`; a run started elsewhere fails and says so. A UI test that reads where a screen scrolled calls `settle()` from `src/test/harness.tsx` first. A test that depends on an array element reads it through `present()` in `src/test/present.ts`.

## Build

```sh
bun run build      # dist/main.js and both workers under dist/collect/
bun run compile    # the standalone ./vsys binary the release and the vsys-git package ship
bun run smoke      # one fixture sample with the bundle and one with a freshly compiled binary
```

A new worker thread goes into `entrypoints` in `scripts/build.ts` and `ARTIFACTS` in `scripts/ci.py`; [layers.md](docs/architecture/layers.md) says why.

## Benchmarks

```sh
bun run bench            # a fixture of scopes and processes: elapsed and processor time per sample
bun run bench:scratch    # a scratch tree scanned with and without the duty cycle; in the check contract
bun run bench:history    # history writes alone and under disk load, then replay over a filled window
bun run bench:writes     # the write budget alone; in the check contract
```

`bench:scratch` is the one instrument that sees the traversal's rest, because the bound lives in a timer on a worker thread where a unit test stages the clock. `bench:writes` holds the median history write to the budget without disk load, because the cost under load depends on the disk as much as the code. Each prints what it refuses.

## Release

1. From a clean index and working tree, set `COMMIT_GUARDS_CHANGELOG_COLLATE=1` and run `.agents/skills/commit-guards/scripts/changelog-entries --collate`. It folds the `changelog.d` fragments into the `[Unreleased]` section of `CHANGELOG.md` and deletes them. A nonzero exit halts the release.
2. Set `version` in `package.json` to the release's version, picked by [the commit-guards release-version rule](.agents/skills/commit-guards/CHECKS.md#release-versions).
3. Move the collated entries under a new `## [<version>] - <date>` heading in `CHANGELOG.md`, leaving an empty `## [Unreleased]` above it. Confirm every breaking change carries its **Breaking** call-out and its migration note.
4. Commit with `COMMIT_GUARDS_CHANGELOG_COLLATE=1` set. That declaration is what lets the `commit-msg` lane count the `CHANGELOG.md` change as the entry the version bump owes.
5. Tag `v<version>` and push the tag. `.github/workflows/release.yml` runs on the tag: it builds the archives, publishes the GitHub Release and updates the `vsys` AUR package.

### Secrets

`AUR_SSH_PRIVATE_KEY` holds the AUR key's contents, which CI uses to push `vsys` and `vsys-git` to the AUR. Running `packaging/publish-aur.sh` by hand takes `AUR_SSH_KEY_FILE` instead, the path to a key already on disk, so no private key is copied anywhere. The script verifies the AUR against the host keys pinned in `packaging/aur-known-hosts` and reads and writes nothing under `~/.ssh`.

### AUR packages

Both AUR packages depend on `python`, `systemd` and `systemd-libs`, because the warden uses Python and `libsystemd.so.0`, and vsys and the warden run the systemd tools.

Both AUR packages disable makepkg strip and debug splitting, because stripping a Bun compiled binary removes its appended program bundle.

The first push to the AUR creates each package, so bootstrap each one with the script CI runs. It pins the version, fills in the published checksums, and refuses to push a recipe that still carries a `SKIP` placeholder.

```sh
export AUR_SSH_KEY_FILE=~/.ssh/vgs_aur_rsa
packaging/publish-aur.sh vsys-git       # any time
packaging/publish-aur.sh vsys 0.9.0     # only once the release is published
```

Bootstrap `vsys` only after its GitHub Release exists, because the script reads `SHA256SUMS` from it.
