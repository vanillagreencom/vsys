# D004: Ship the warden as a separate vsys component

[← Decision Index](INDEX.md)

**Date**: 2026-09-28

**Status**: Active

**Research**: —

**Decision**: vsys ships the agent warden from `warden/` as a separate optional component, in Python, running from its own systemd user timer. The dashboard observes; the warden corrects.

**Why**: Automatic correction inside the dashboard runtime would break its promise to read without changing. The warden has a different failure domain, since it must keep working while the dashboard is closed, and it stays Python because it calls pidfd and libsystemd directly.

**Rejected**: Merging the warden into the dashboard runtime as one product. It gives one process to install, and it makes every vsys user opt into automatic correction.

**Revisit when**: A Bun foreign-function interface port can call pidfd and libsystemd with the same safety, or the dashboard needs to own an automatic correction under a new explicit promise.
