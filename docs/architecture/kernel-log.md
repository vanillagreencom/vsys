# Kernel log

Covers: src/collect/kernel-log.ts src/collect/kernel-log.test.ts

The kernel log is one of the three sources [storage integrity](storage-integrity.md) reads: it records each failed checksum read when it happens, whether or not a vsys process was watching. How a logged failure weighs against a check report and the error counter is in storage integrity.

## Reading

- Btrfs logs every data read that fails its checksum as `csum failed root R ino I`. `KernelLog` in `src/collect/kernel-log.ts` reads those lines from `journalctl --output=json`, searched with `--grep`, so no helper is needed.
- The `kernel-log` capability searches for one kernel message from this boot, once at start. An answer with none means this user cannot read the system journal. A collector whose probe failed never searches.
- The message text is kernel prose, not an interface. It stands in for the `error_stats` counters under `/sys/fs/btrfs`, which give a count with no inode and no time it failed, and the reporter's `unable to fixup` lines stand in for `btrfs scrub status`, which gives counts with no address and, on btrfs-progs v7.1, no JSON form. A rewording leaves the lines unmatched: the log then names no failure, and a report lists fewer addresses than it counts, which Storage shows as unnamed damage.
- The first search reads every boot the journal holds. Each later search starts after the cursor the last one ended on. The dashboard's first sample and a plain `--once` pay it; a collector built for a settings change resumes from the cursor. `--once --summary` skips the log, as it skips scratch, so its integrity reads the counter alone.
- A search that fails records a source error naming `journalctl`, and the failures earlier searches read still stand. The log reads as unread only where no search has completed.
- A logged failure is a dated reading even where the counter's record of past growth could not be read, so the line gives its time and source.
- A device name holds for one boot. A failure is matched to its filesystem through the `first mount of filesystem` line its own boot logged for that device. A failure from this boot with no such line is matched through this boot's sysfs. A failure from an earlier boot with no such line is left out.
- Resolving an inode to a path needs root. A failure the kernel logged after the last finished check shows as an inode in a subvolume. A check that finished later read the filesystem end to end and covers it.
- `csumFailures` holds the newest 64 inodes per filesystem. Null means the log was not read, which is never a log of none.

## Invariants

1. A logged failure belongs to the filesystem its own boot mounted on that device, an earlier boot's failure with no mount line is left out, and a search that failed to parse is asked again from the same cursor. `src/collect/kernel-log.test.ts` renames a device across two boots and checks each.
2. A kernel log the probe could not search is never searched, and a search that fails names `journalctl`. The reading is unread only where no search has completed; invariant 3 holds what a later failure keeps. `src/collect/collector.test.ts` counts the searches; `src/collect/kernel-log.test.ts` checks the failure.
3. A failed search keeps the failures earlier searches read, beside a `journalctl` source error; a search that matched nothing is an answer; the search pattern keeps the lines the parser reads; and the summary path never searches. A collector handed the log resumes its cursor, and `createCollector()` hands on the log the replaced collector held. `src/collect/kernel-log.test.ts` and `src/collect/collector.test.ts` check each.
4. A journalctl search that stalls is never left blocking every future sample: `spawnText()` sends SIGTERM at `kernelLogTimeoutMs`, then SIGKILL after a further `killGraceMs` for a child still running, which also bounds one that ignores SIGTERM. `src/collect/io.test.ts` kills a real SIGTERM-resistant child and checks the escalation.
