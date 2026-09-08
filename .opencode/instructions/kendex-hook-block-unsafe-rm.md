# Safety: block-unsafe-rm

**Safety: Block a recursive rm with a path operand that starts with a variable that may expand empty — a path outside the working tree wherever that variable is empty or unset. Names the rewrite the harness accepts without a prompt.**

The harness stops the whole session on that shape with a "Dangerous rm operation on possibly-empty variable path" prompt; refusing it here lets the agent rewrite and continue. One regex over the raw command decides: an rm, a recursion flag — a single-dash cluster carrying r or R, or `--recursive` — and an operand rooted in `$NAME`, `${NAME}` or `${NAME:-…}`, in either order and wherever in that command they stand. `${NAME:?…}` is the one form that cannot expand empty and it passes, and a redirection target is not an operand. Reading the three parts wherever they stand refuses a harmless command that merely spells them — `git rm -r --cached $X`, a quoted `rm -rf $X` inside an echo — and that is the accepted cost: it fails closed, so it stalls one command rather than deleting a tree. A bypass the shell would assemble — a quoted flag, a line continuation, a variable holding the flag — is not seen here; the harness prompt is the backstop, and this hook only spares the session that stall.

Before executing Bash operations, the agent must verify this constraint is met.
