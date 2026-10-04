# Warden tunables

Covers: warden/agent-warden warden/agent-confine warden/agent-confine-lineage-capped warden/agent_warden_settings_test.py warden/systemd/agent-warden.timer

[warden.md](warden.md) covers what the warden moves and caps, and [warden-reaper.md](warden-reaper.md) what it reaps. This file covers the environment settings the launcher and the warden read, and how the warden treats a value outside the accepted format.

| Variable | Consumer | Default | Accepted value | Effect |
| --- | --- | --- | --- | --- |
| `AGENT_WARDEN_ONLY` | warden | unset | Comma-separated process ids | Limits one scan to listed process ids. |
| `AGENT_WARDEN_INTERVAL` | warden | `30` | Decimal number above 0 | Seconds between status ticks. Keep it equal to `OnUnitActiveSec` in `warden/systemd/agent-warden.timer`. |
| `AGENT_WARDEN_SPLIT_SESSIONS` | warden | `1` | `0` disables; any other value enables | Splits nested agent sessions when the lineage is not capped. |
| `AGENT_WARDEN_ORPHAN_GRACE` | warden | `300` | Finite decimal number | Seconds an orphan must stay orphaned before a reap can happen. |
| `AGENT_WARDEN_SCRATCH_GRACE` | warden | `60` | Finite decimal number | Seconds a scratch directory with no matching scope yet survives a reap tick. |
| `AGENT_WARDEN_REAP` | warden | `1` | `0` disables; any other value enables | Enables orphan reaping. |
| `AGENT_WARDEN_JOB_UNITS` | warden | `orch-*.service` | Unit name patterns | Whitespace-separated systemd unit patterns left in place. |
| `AGENT_WARDEN_ORPHAN_PROCS` | warden | `40` | Integer | Process count that makes an orphan harmful. |
| `AGENT_WARDEN_ORPHAN_CPU` | warden | `0.5` | Finite decimal number | CPU cores that make an orphan harmful. |
| `AGENT_SCOPE_TASKS_MAX` | both | `8192` | Integer or `infinity` | Per-session task ceiling. `infinity` sets no per-session cap, and the warden then caps no scope. |
| `AGENT_SCOPE_TASKS_WARN` | warden | 75% of `AGENT_SCOPE_TASKS_MAX` (`6144`), or none when it is `infinity` | Integer | Per-session task warning threshold. |
| `AGENT_SCOPE_MEM_HIGH` | launcher | `64G` | systemd size | Per-session soft memory ceiling passed to systemd. |
| `AGENT_SCOPE_MEM_HIGH_BYTES` | warden | `68719476736` | Integer | Per-session soft memory ceiling used for warden-created scopes and lineage baseline. |
| `AGENT_SCOPE_MEM_WARN_BYTES` | warden | 75% of `AGENT_SCOPE_MEM_HIGH_BYTES` | Integer | Per-session memory warning threshold. |
| `AGENT_TMPDIR` | both | unset | Directory path | Overrides the scratch parent directory. The launcher creates each lane's subdirectory under it; the warden reads the same value to find which subdirectories to reap. |
| `AGENT_TEST_THREADS` | launcher | `8` | Positive integer | Test-thread cap exported by the launcher. |
| `AGENT_BUILD_JOBS` | launcher | `16` | Integer | Build-job cap exported by the launcher. |
| `AGENT_MOLD_JOBS` | launcher | `1` | `1`, or empty | One mold link at a time machine-wide. Mold honours only `1`, so empty or `2` sets no cap. |

The warden reads an empty numeric setting as unset, as the launcher does for `AGENT_SCOPE_TASKS_MAX`. It logs any other value outside the accepted format and uses the default, so a bad value never stops a tick or the nested-launch helper. A percentage `AGENT_SCOPE_TASKS_MAX`, which systemd accepts, is outside the warden's format: the launcher passes it to systemd, and the warden uses `8192`. `warden/agent_warden_settings_test.py` covers this in `test_numeric_setting_rows`, `test_task_cap_rows`, `test_start_scope_tasks_max_rows`, `test_lineage_helper_answers_rows` and `test_settings_mutants_fail`.

`AGENT_SCOPE_MEM_HIGH` and `AGENT_SCOPE_MEM_HIGH_BYTES` must name the same size. The launcher reads the systemd size string. The warden reads the byte value for warden-created scopes and for the lineage baseline.
