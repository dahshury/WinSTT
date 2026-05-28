#!/usr/bin/env bash
#
# Run mutmut on ONE source module with a scoped, fast test runner.
#
# Usage (from server/):
#   bash scripts/mutmut_module.sh <src-file> <test-file-or-dir>
#   bash scripts/mutmut_module.sh src/recorder/domain/state_machine.py tests/unit/recorder/test_state_machine.py
#
# Why this wrapper exists — two Windows-specific mutmut footguns:
#   1. mutmut 3.x DROPPED native Windows support ("please use WSL"), so the
#      project pins mutmut 2.x (`uv pip install "mutmut<3"`).
#   2. mutmut 2.x still crashes on Windows in two places unless worked around:
#        a. Its braille spinner + 🙁 emoji output hit the cp1252 console codec
#           (UnicodeEncodeError) — fixed by forcing UTF-8 stdio below.
#        b. Its runner subprocess is launched via cmd.exe, which can't resolve
#           a `.venv/Scripts/python.exe` path with forward slashes — fixed by
#           activating the venv so a bare `python` IS the venv interpreter.
#
# Mutation testing is INHERENTLY sequential per working tree: mutmut mutates the
# source in place, so two concurrent runs on the same checkout cross-contaminate.
# Run modules one at a time (or give each its own git worktree).
#
# For CI / Linux, none of the Windows workarounds are needed — `mutmut run`
# works directly. This wrapper is the Windows-friendly path.
set -uo pipefail

cd "$(dirname "$0")/.."

SRC="${1:?usage: mutmut_module.sh <src-file> <test-file-or-dir>}"
TESTS="${2:?usage: mutmut_module.sh <src-file> <test-file-or-dir>}"

# shellcheck disable=SC1091
source .venv/Scripts/activate
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

echo "=== mutmut run: $SRC (tests: $TESTS) ==="
mutmut run \
	--paths-to-mutate "$SRC" \
	--runner "python -m pytest -x -q --no-cov -p no:cacheprovider $TESTS" \
	--simple-output --CI || true

echo "=== mutmut results ==="
# Strip CR + mutmut's trailing how-to footer; keep the bucket counts + ids.
mutmut results 2>&1 | tr -d '\r' | grep -vE "^To apply|^To show|^    mutmut|^$"
