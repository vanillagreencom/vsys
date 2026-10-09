#!/usr/bin/env bash
# Runs the cloud defect review 7 proofs. Each proof fails on main by design;
# see review/tests/README.md. It runs from the repository root, where
# bunfig.toml preloads the warning gate.
set -euo pipefail
root="$(dirname "$0")/../.."
(cd "$root" && bun test review/tests/)
