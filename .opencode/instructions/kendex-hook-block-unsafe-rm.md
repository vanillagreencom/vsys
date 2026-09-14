# Safety: block-unsafe-rm

**Safety: Block any rm with a path operand that starts with a variable that may expand empty. Names the rewrite the harness accepts without a prompt.**

One regex over the raw command refuses any rm with an operand rooted in `$NAME`, `${NAME}` or `${NAME:-…}`, including globs, regardless of flags. `${NAME:?…}` aborts on empty and passes. A redirection target is not an operand. The scan can refuse harmless text that spells the same shape, such as `git rm --cached $X` or an echo containing `rm $X`. It does not parse shell syntax: a split command name or line continuation can escape it and still reach the harness prompt. Every refusal opens with `block-unsafe-rm: <key>=<value>`; output from a command this hook runs follows that line.

Before executing Bash operations, the agent must verify this constraint is met.
