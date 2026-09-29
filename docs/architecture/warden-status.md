# Agent warden status JSON

Covers: warden/agent-warden, warden/fixtures/status-*.json

The agent warden writes `status.json` for programs that watch agent health. The file contains numbers and ids only. The consumer owns all words, colours and formatted numbers.

## Path and write rules

`warden/agent-warden` writes `$XDG_RUNTIME_DIR/agent-warden/status.json` at the end of each `--report` or `--correct` tick.

The writer writes all bytes to `status.tmp.<pid>` in the same directory, sets mode `0644`, and replaces `status.json` with `os.replace`. `AgentWardenRules.test_status_writer_uses_rename_and_mode` checks the mode, the inode change and the complete old file seen before rename. `AgentWardenRules.test_status_writer_handles_short_writes` checks short writes. `AgentWardenRules.test_status_writer_in_place_mutant_fails` checks that a writer without rename fails that control.

A failed scan still writes `status.json`. It sets `error` to a stable id and sets `outside`, `waiting`, `orphans` and `contained` to `null`. It still reads `slice` and `lanes` from the cgroup tree. `AgentWardenRules.test_failed_scan_tick_writes_error_status` checks this rule.

The warden does not write `status.json` for `--status`, `--selftest`, or when `AGENT_WARDEN_ONLY` is set. Restricted fixture runs therefore do not overwrite the live status file. `AgentWardenRules.test_status_and_only_runs_do_not_write_status` checks this rule with a sentinel file.

A write failure logs `status write failed` and does not fail the tick. The state write happens before the status write, still completes when the status write fails, and the lock is released. `AgentWardenRules.test_state_write_survives_status_write_failure` checks this rule.

## Versioning

`schema` is `1.0`.

A minor version adds fields or enum values that old consumers can ignore.

A major version can remove fields, change a type, change a unit, or change an enum meaning. Consumers refuse an unknown major. `status_errors()` checks that the major is `1`, and the selftest plants `2.0` as the control.

## Fields

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `schema` | string | major.minor | Never null. |
| `time` | number | Unix epoch seconds | Never null. |
| `mode` | `correct` or `report` | id | Never null. |
| `interval` | number | seconds | Never null. The default is `30`. `AGENT_WARDEN_INTERVAL` can override it and must match `OnUnitActiveSec` in `warden/systemd/agent-warden.timer`. |
| `error` | string or null | id | Null means scan and plan completed. `scan` means scan or plan failed. |
| `slice` | object or null | cgroup counters | Null means `agents.slice` is absent. |
| `lanes` | list or null | cgroup scopes | Null means `agents.slice` exists but its direct scopes could not be listed. Empty means the slice is absent or has no direct scopes. |
| `outside` | list or null | planned process trees | Null means the scan failed. |
| `waiting` | list or null | planned process trees | Null means the scan failed. An empty list in report mode means the warden did not try to move. |
| `orphans` | list or null | tracked scopes | Null means the scan failed. Reaped scopes are not listed. |
| `contained` | list or null | job units | Null means the scan failed. |
| `events` | list | event ids | Empty means no recent event. The ring keeps the last 50 events. |
| `counters` | object | state counters | A field is null when `state.json` existed but could not be read or parsed. |

### `slice`

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `memory` | integer or null | bytes | `memory.current` could not be read or parsed. |
| `high` | integer, `max`, or null | bytes | `memory.high` could not be read or parsed. `max` means unlimited. |
| `max` | integer, `max`, or null | bytes | `memory.max` could not be read or parsed. `max` means unlimited. |
| `tasks` | integer or null | Linux task count | `pids.current` could not be read or parsed. This includes threads. |
| `tasksMax` | integer, `max`, or null | Linux task count | `pids.max` could not be read or parsed. `max` means unlimited. This includes threads. |
| `headroomOk` | boolean or null | id | Null means the memory counters needed for the headroom rule were unknown. |

An absent `agents.slice` makes `slice` null. The move guard still treats an absent slice as empty headroom, so the first move can create it. If the slice exists and a needed counter is unreadable, the move guard still fails closed.

### `lanes[]`

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `scope` | string | systemd unit name | Never null. |
| `label.tool` | string or null | id | Null means no agent process in the scope could be identified. |
| `label.worktree` | string or null | basename | Null means the process working directory could not be read. |
| `tasks` | integer or null | Linux task count | `pids.current` could not be read or parsed. This includes threads. |
| `tasksMax` | integer, `max`, or null | Linux task count | `pids.max` could not be read or parsed. `max` means unlimited. This includes threads. |
| `memory` | integer or null | bytes | `memory.current` could not be read or parsed. |
| `memoryHigh` | integer, `max`, or null | bytes | `memory.high` could not be read or parsed. `max` means unlimited. |
| `near` | list of `tasks` and `memory` | ids | Empty means no readable counter crossed its warning threshold. |

`lanes` is null when `agents.slice` exists but cannot be listed. Lanes sort by `scope` for stable output. The `near` thresholds are `AGENT_SCOPE_TASKS_WARN` and `AGENT_SCOPE_MEM_WARN_BYTES`.

### `outside[]` and `waiting[]`

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `reason` | `escaped-launch`, `unconfined-agent`, `unconfined-build`, or `nested-session` | id | Never null. |
| `pid` | integer | process id | Never null. |
| `start` | integer | `/proc/<pid>/stat` start time | Never null. |
| `tool` | string | process `comm` | Never null. |
| `processes` | integer | process count | Never null. |

`outside` lists the trees found by the planner. `waiting` lists the correct-mode trees held back by the slice headroom rule during this tick.

### `orphans[]`

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `scope` | string | systemd unit name | Never null. |
| `processes` | integer | process count | Never null. |
| `cores` | number or null | CPU cores | Null means CPU has not yet been measured across two ticks. |
| `since` | number | Unix epoch seconds | Never null. |
| `harmful` | boolean | id | Never null. |

### `contained[]`

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `unit` | string | systemd unit name | Never null. |
| `processes` | integer | process count | Never null. |

`contained` lists job units that carry their own limits and stay outside a warden scope.

### `events[]`

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `id` | integer | sequence | Never null. It is at least the current Unix epoch millisecond, the prior persisted sequence plus one, the last kept event plus one, and, after missing or unreadable state, the highest published `status.json` event id plus one. |
| `time` | number | Unix epoch seconds | Never null. |
| `kind` | `moved`, `partial`, `reaped`, `near-cap`, `waiting`, or `failed` | id | Never null. |
| `scope` | string or null | systemd unit name | Null means no single scope owns the event. |
| `pid` | integer or null | process id | Null means no single process owns the event. |
| `processes` | integer or null | process count | Null means the event has no process count. |
| `near` | `tasks`, `memory`, or null | id | Null except for `near-cap`. |

`near-cap` and `waiting` events open once per episode. A still-near scope does not add a new event on each tick. `AgentWardenRules.test_status_event_ring_and_episode_dedupe` checks the ring size, increasing ids and episode rule. `AgentWardenRules.test_event_ids_increase_across_state_reopen_and_reset` checks persisted ids, ids after a missing `state.json`, and the published `status.json` id floor.

### `counters`

| Field | Type | Unit | Null meaning |
| --- | --- | --- | --- |
| `moves` | integer or null | count | `state.json` existed but could not be read or parsed. |
| `partial` | integer or null | count | `state.json` existed but could not be read or parsed. |
| `reaped` | integer or null | count | `state.json` existed but could not be read or parsed. |
| `moveFailures` | integer or null | count | `state.json` existed but could not be read or parsed. |
| `scanFailures` | integer or null | count | `state.json` existed but could not be read or parsed. |
| `skips` | integer or null | count | `state.json` existed but could not be read or parsed. |

A missing `state.json` means a fresh runtime directory. The counters are zero in that case. A state file that cannot be read, cannot be parsed, or has invalid persisted counter, event or episode fields is unreadable state. The warden uses fresh defaults and reports counters as null. An invalid orphan record is dropped, so the orphan must be observed again before reaping.

## Fixtures

- `warden/fixtures/status-calm.json`: no pending work, no near limits and no events.
- `warden/fixtures/status-near-limit.json`: one lane near task and memory thresholds.
- `warden/fixtures/status-holding-off.json`: correct mode found a tree but memory headroom blocked the move.
- `warden/fixtures/status-partial.json`: a partial move event and counter.
- `warden/fixtures/status-reaped.json`: a reaped orphan event and counter.

`AgentWardenRules.test_status_fixtures_validate_and_match_builders` validates every fixture with `status_errors()` and compares it with `status_fixture_docs()`.

## Validation

`status_errors()` validates the schema major, required keys, enums, event count, increasing ids, nullable lanes and nullable counters.

`warden/agent-warden --selftest` validates the calm, near-limit, holding-off, partial, reaped and failed-scan documents. It also drives a normal and failed tick through `status_from_tick()`, and checks that an unknown schema major fails.

`AgentWardenRules.test_unreadable_status_counters_stay_null` checks that unreadable cgroup counters and a corrupt or wrongly typed `state.json` become null, not zero. `AgentWardenRules.test_bad_orphan_state_is_dropped_before_reap` checks that an invalid orphan state record is re-observed instead of trusted. `AgentWardenRules.test_unreadable_lane_listing_stays_null` checks that a failed scope listing becomes null, not an empty list. `AgentWardenRules.test_orphan_reap_exception_status_is_null` checks that a failed orphan pass becomes null, not an empty list.
