# Proof tests for cloud defect review 7

Run them from the repository root, so that `bunfig.toml` preloads the warning gate:

```sh
bun test review/tests/      # or: review/tests/run-all.sh
```

Each proof asserts what the product should do, so on main it fails and the failure shows the defect. A test whose name starts with "control:", and the 120-column case in `footer-status.test.ts`, pass on main. They show that the fixture works.

| File | Finding |
| --- | --- |
| `unreachable-key.test.tsx` | 1 |
| `agent-count.test.ts` | 2 |
| `open-files.test.tsx` | 3 |
| `group-status.test.ts` | 4 |
| `builds-unknown-count.test.tsx` | 5 |
| `storage-count.test.tsx` | 6 |
| `unread-env-limits.test.tsx` | 7 |
| `footer-status.test.ts` | 8 |
| `setting-display.test.ts` | 9 and 10 |

The tests use stub snapshots, the shared fixture, and private directories made with `mkdtemp` and removed afterwards. No test reads or signals a real process, touches systemd, or opens `/dev/dri`.
