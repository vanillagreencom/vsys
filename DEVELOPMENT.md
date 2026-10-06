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

A new worker thread goes into `entrypoints` in `scripts/build.ts` and `ARTIFACTS` in `scripts/ci.py`; [collection-threads.md](docs/architecture/collection-threads.md) says why.

## Benchmarks

```sh
bun run bench            # a fixture of scopes and processes: elapsed and processor time per sample
bun run bench:scratch    # a scratch tree scanned with and without the duty cycle; in the check contract
bun run bench:history    # history writes alone and under disk load, then replay over a filled window
bun run bench:writes     # the write budget alone; in the check contract
```

`bench:scratch` is the one instrument that sees the traversal's rest, because the bound lives in a timer on a worker thread where a unit test stages the clock. `bench:writes` holds the median history write to the budget without disk load, because the cost under load depends on the disk as much as the code. Each prints what it refuses.

## Release

[docs/RELEASING.md](docs/RELEASING.md) is the procedure.
