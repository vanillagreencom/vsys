# Safety: block-repo-copy

**Safety: Block a copy (cp, rsync, tar, git clone) whose source names a `.git` or `target` path component and whose destination is under /tmp, /var/tmp or $TMPDIR. Suggests reading the source in place or building a minimal fixture.**

Temp destinations are commonly RAM-backed tmpfs; a multi-gigabyte tree copy fills the filesystem and every process writing there then fails with ENOSPC. One regex over the raw command decides, in the order the words stand, so nothing is resolved, expanded or stat-ed: a source whose last path component IS `.git` or `target` is expensive by construction, and a destination spelled under a temp root is scratch. Both edges of that component are tested, so a word merely ending in one — a `…/bar.git` clone URL, a `build-target` directory — is not it. A source reached through a variable, and a repository named only by its working-tree path, are not seen; neither is a `tar -czf DEST SRC`, which spells the destination before the source. The reading runs the other way too: the three parts count wherever they stand, a quoted string and a comment tail included, so a read-only command spelling out a copy is refused as the copy it is not.

Before executing Bash operations, the agent must verify this constraint is met.
