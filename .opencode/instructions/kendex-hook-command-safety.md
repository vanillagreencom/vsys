# Safety: command-safety

**Safety: On harnesses that execute hooks, refuse shell tool command text matching COMMAND_SAFETY_DENY_PATTERN from project settings. An absent policy is inactive. Matching is textual, including quoted text, and does not inspect the desktop or running processes.**

When executed with a configured policy, blocks matching command text before the shell tool runs. Unreadable input, missing settings support, and invalid or explicitly empty patterns refuse execution.

Before executing Bash operations, the agent must verify this constraint is met.
