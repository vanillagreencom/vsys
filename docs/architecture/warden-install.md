# Warden installer

Covers: warden/install warden/install_test.py warden/systemd/ src/warden.ts

The installer writes the optional warden's systemd user units and its shared data file. It lives in the warden component. The dashboard only dispatches to it. [warden.md](warden.md) covers what the warden does once it runs.

## Install, uninstall and status

`vsys warden install` installs the systemd user units in `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/`. It writes `agent-warden.service`, `agent-warden.timer` and `agents.slice`, copies the shipped shared agent-tool list from `<warden dir>/../data/agent-tools.json` to `${XDG_DATA_HOME:-$HOME/.local/share}/vsys/agent-tools.json`, then reloads the user manager and enables `agent-warden.timer`. It refuses before writing when the shipped list is missing, because the warden reads its classification data from that file ([warden.md § Classification data](warden.md#classification-data)). The install shell and the user service must see the same `XDG_DATA_HOME`, or the warden looks in a different data directory. `warden/install_test.py` checks the written files, the copied data, the missing-list refusal, the reload call and the enable call with a stub `systemctl`.

`src/warden.ts` resolves the warden directory in one place and dispatches to `warden/install`. The source checkout wins when `../warden/install` exists beside `src/`. An installed `vsys` binary otherwise looks for `../lib/vsys/warden` relative to the real path of the executable. This is the packaging contract for release archives and `install.sh`. `src/warden.test.ts` checks the order and the error that lists every path tried.

The service template keeps `ExecStart=@WARDEN_DIR@/agent-warden --correct`. The installer fills it with the resolved warden tree. It escapes `%` and `$` for systemd and quotes paths with whitespace or quotes. It refuses the install when `agent-warden` is not executable. `warden/install_test.py` covers the path substitution and percent and dollar escaping.

Each installed unit starts with the vsys warden marker. The installer refuses the whole install when any target is a symlink or an unmarked file, so it does not write through a dotfiles stow link. Install and uninstall also refuse when the systemd unit directory, its `user` child, or the vsys data directory is itself a symlink, because stow can fold whole directories. An unreadable target is unknown; install refuses it, status reports it, and uninstall leaves it in place. A marked file is ours and can be rewritten. `warden/install_test.py` covers foreign files, unreadable files, symlinks, folded directory symlinks and reinstalling marked files.

The shared agent-tool list is JSON, so the installer does not add a marker to it or add schema keys to it. Instead, the installer records one or more `# vsys-warden-data: sha256=<hex>` lines in the marked service unit. During an upgrade it records both the new shipped-list hash and the currently installed data hash, so an interrupted data write remains retryable. A later install overwrites `${XDG_DATA_HOME:-$HOME/.local/share}/vsys/agent-tools.json` only when the file is absent or its hash matches a hash in the existing service unit. Otherwise the data file is foreign and the whole install refuses. `warden/install_test.py` covers the hash record, reinstall, interrupted upgrade retry and foreign-data refusal.

The installer never writes, overwrites or removes the local overlay `$HOME/.config/vsys/agent-tools.json`. `warden/install_test.py` covers install and uninstall with a pre-existing local overlay.

`vsys warden uninstall` disables only `agent-warden.timer`, stops only a marked `agent-warden.service`, removes only marked files, removes the copied shared agent-tool list only when its hash matches the service unit record, and removes a leftover `timers.target.wants/agent-warden.timer` symlink only when it points at the marked timer. It leaves foreign and unreadable files in place and names them. It never stops `agents.slice` and never touches scopes, so running agents keep running. After daemon reload, removing the slice file removes the template limits for future units. `warden/install_test.py` covers removal, service stop, and files left in place.

`vsys warden status` is read-only. It reports whether each unit and the copied shared agent-tool list are installed by vsys, foreign, missing or unknown. It reports whether the timer is enabled and active, the timer's last trigger, the service result and whether `cpu`, `memory` and `pids` are delegated to `user@.service`. It exits successfully only when the service result is `success`. A failed read stays unknown and makes the status fail. `warden/install_test.py` covers complete delegation, missing delegation, failed service result and unknown delegation.

The installer does not install the root desktop-protection pack. That pack owns the `MemoryLow` chain and cgroup recursive protection. It remains a separate root-owned setup.

The manual fallback is to copy `warden/agent-warden`, `warden/agent-confine` and `warden/agent-confine-lineage-capped` into a directory on `PATH`, copy the templates from `warden/systemd/` into the systemd user-unit directory, replace `@WARDEN_DIR@` with the script directory, copy `data/agent-tools.json` into the vsys data directory, add the data hash comment to the service unit, then reload the user manager and enable `agent-warden.timer`. Remove any symlink target first; do not write through it.

## Owner workstation migration

Do not run two wardens.

The owner workstation currently gets the scripts and units from dotfiles. In the migration pass, dotfiles stops stowing `agent-warden`, `agent-confine`, `agent-confine-lineage-capped`, `agent-warden.service`, `agent-warden.timer` and `agents.slice`. `vsys warden install` writes only the marked unit files and shared data file. It does not install the launchers. The owner keeps the absolute `agents.slice` memory values tuned for that machine as a local drop-in under `agents.slice.d/*.conf`, because the installer writes the percentage template.

Migration order:

1. Set `AGENT_TMPDIR=$HOME/dev/.scratch/agents` in the environment that starts agent wrappers.
2. Install `data/owner-agent-tools.json` as `$HOME/.config/vsys/agent-tools.json` through dotfiles before switching the warden.
3. Remove the dotfiles stow links for `agent-warden`, `agent-confine`, `agent-confine-lineage-capped`, `agent-warden.service`, `agent-warden.timer` and `agents.slice`.
4. Put the owner `agents.slice` values in a local drop-in under `agents.slice.d/*.conf`.
5. Link or copy `<warden dir>/agent-warden`, `<warden dir>/agent-confine` and `<warden dir>/agent-confine-lineage-capped` into one directory on `PATH`, such as `~/.local/bin`, before new panes depend on them. Keep all three scripts from the same warden tree, because the launcher and lineage helper resolve their sibling scripts from their invoked directory.
6. Run `vsys warden install`, whose daemon reload picks up the drop-in.
7. Verify that no warden script or unit points into dotfiles.
8. Check that exactly one `agent-warden.timer` exists.
9. Run `python3 ~/.local/bin/agent-warden --selftest` with the same user environment that starts the timer.
