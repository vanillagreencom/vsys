# Safety: block-bare-cd

**Safety: Refuse a command with a line that is only a `cd`. Where the shell persists across tool calls (Claude Code) a bare cd re-roots every later command and every hook that judges the working directory, while instruction files and hook paths stay with the launch directory; a cd into a worktree inside the repository, Claude Code's default `.claude/worktrees/<name>/`, also loads that tree's instruction files a second time as files there are read. Names the scoped form, `(cd /path && command)`, and, where the harness has one (Claude Code's EnterWorktree), its worktree tool for a move.**

Reads the command text only. On a harness that runs each command in a fresh shell (Codex, the Pi carrier) a bare cd changes nothing and the refusal costs one rewrite; the scoped form is right on every harness.

Before executing Bash operations, the agent must verify this constraint is met.
