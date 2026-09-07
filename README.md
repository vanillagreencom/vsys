# vsys-view

Terminal dashboard for an agent fleet on Linux: who is using the CPU, which
lanes are starved, which agent processes escaped their resource slice, what is
building, and whether the disks are healthy. Observes only; never changes
anything.

Built on OpenTUI (Bun + TypeScript + Zig renderer). Plan: `docs/plans/`.
