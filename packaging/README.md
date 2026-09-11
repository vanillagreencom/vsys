# Package channels

vsys-view publishes to one channel, the Arch User Repository (AUR). The recipe lives in this repository under `arch/`; the AUR repository is a copy that a workflow overwrites, never a place to edit.

## Arch

```bash
yay -S vsys-view-git
```

`vsys-view-git` builds the current `main` of this repository. There is no release package yet, because the project has no GitHub release to point one at; a `vsys-view` recipe pinned to a version tag joins `arch/` when the first release exists.

The package installs the bundled `main.js` and its production `node_modules` under `/usr/lib/vsys-view` and a `/usr/bin/vsys-view` wrapper that runs them with Bun. Bun comes from the AUR package `bun-bin`, which the recipe names in both `depends` and `makedepends`. OpenTUI's native library ships inside `node_modules`, so the recipe turns strip and debug packaging off.

## The recipe

`arch/vsys-view-git/PKGBUILD` is the recipe and `arch/vsys-view-git/.SRCINFO` is the metadata AUR clients read. After any PKGBUILD edit, regenerate the metadata from the recipe directory:

```bash
makepkg --printsrcinfo > .SRCINFO
```

`scripts/check-aur-sync.py` fails when the two disagree. With `--remote` it also clones the AUR repository and diffs the published files against this tree; an empty AUR repository reports the package as not yet published.

To exercise the recipe on an Arch machine, copy the PKGBUILD to a scratch directory and run `makepkg -s`. The build clones this repository, installs the production dependencies with the lockfile, and bundles `src/main.ts`, so it needs network access.

## The workflow

`.github/workflows/publish-aur.yml` runs `scripts/publish-aur.sh` on every push to `main` that touches `packaging/arch/`, either script or the workflow itself. The script checks the recipe, clones the AUR repository, copies `PKGBUILD` and `.SRCINFO` in, and pushes a commit when they differ. The AUR answers a package name nobody has pushed with an empty repository, so the first real push creates `vsys-view-git` on the AUR. Until that push runs, `yay -S vsys-view-git` finds nothing.

The workflow can also be started by hand from the Actions tab with two inputs: `packages`, a space-separated list that today accepts only `vsys-view-git`, and `dry_run`. A dry run clones over HTTPS, prints the diff it would push and pushes nothing, so it needs no secret. The same dry run works locally:

```bash
scripts/publish-aur.sh --dry-run
```

A weekly scheduled job runs `scripts/check-aur-sync.py --remote` and fails when the published recipe has drifted from this tree, including when the package has not been published at all.

## Credentials

A real publish needs two repository settings:

- The secret `AUR_SSH_PRIVATE_KEY`: the private half of an SSH key registered on the AUR account that maintains `vsys-view-git`. The script fails, rather than skipping the publish, when it is empty.
- The variable `AUR_SSH_KNOWN_HOSTS`: the `aur.archlinux.org` host key line, checked against the fingerprints published on the Arch wiki's AUR page. The workflow refuses to guess a host key or to accept whatever answers.

The commit identity on the AUR side comes from the optional variables `AUR_COMMIT_NAME` and `AUR_COMMIT_EMAIL`; without them the script commits as `vsys packaging <packaging@vanillagreen>`.
