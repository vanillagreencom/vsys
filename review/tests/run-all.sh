#!/usr/bin/env bash
# Runs every proof for review/cloud-defect-review-4.md from the repository
# root. Each suite fails on main by design; the exit status is nonzero while
# any finding stands, and the output names each failing case.
set -euo pipefail
cd "$(dirname "$0")/../.."
bun test \
  ./review/tests/notify-stall.test.ts \
  ./review/tests/kernel-log-retry.test.ts \
  ./review/tests/render-cost.test.ts
