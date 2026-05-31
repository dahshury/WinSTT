#!/usr/bin/env bash
#
# Memory-safe FULL frontend coverage + CRAP report.
#
# Why this exists: `bun test --coverage` over the WHOLE suite in one process
# balloons to 34-50 GB (happy-dom DOM accumulation) and thrashes — see
# memory/project_bun_test_memory_blowup. This shards the run so EACH shard is a
# separate bun process (memory is released between shards), then merges the
# per-shard LCOV. `scripts/crap/lcov-parser.ts` SUMS duplicate `SF:` records,
# so plain concatenation is a correct merge.
#
# Sharding strategy (discovered empirically):
#   - Most src dirs: per-directory (light enough: features=66 files ≈ 7-8 GB).
#   - src/shared/ui: PER-FILE — as a dir it hits 47 GB (Base-UI/motion/calendar
#     components are happy-dom monsters).
#   - ALL of electron/: PER-FILE — its batch run triggers the mock.module
#     cross-file pollution (tests fail in-batch → their coverage is LOST →
#     bogus 0% / inflated CRAP). Isolated, each electron test reports true cov.
#
# Usage (from frontend/):
#   bash scripts/crap-coverage-sharded.sh             # coverage/lcov.info + CRAP report (+ reports/crap.json)
#   bash scripts/crap-coverage-sharded.sh --no-crap   # only rebuild coverage/lcov.info
#
# CI: on Linux none of the memory workarounds are needed — a single
# `bun test --coverage` then `bun run scripts/crap.ts --skip-coverage` works.
# This script is the local (Windows/limited-RAM) path.
set -uo pipefail
cd "$(dirname "$0")/.."

SHARD_DIR="${TMPDIR:-/tmp}/winstt-lcov-shards"
rm -rf "$SHARD_DIR"; mkdir -p "$SHARD_DIR"

# Shard files are named by their SANITIZED TEST PATH (path separators -> `__`)
# so the merge can do COLOCATED ATTRIBUTION: each source file's coverage comes
# from its own `*.test.ts(x)` shard, not an unreliable cross-shard merge (Bun's
# per-process line instrumentation is non-deterministic — see merge-lcov-best.mjs).
run_shard() { # run_shard <test-path-or-file>
	rm -f coverage/lcov.info
	timeout 300 bun test "$1" --coverage --coverage-reporter=lcov >/dev/null 2>&1
	if [ -f coverage/lcov.info ]; then
		# e.g. electron/ipc/llm.test.ts -> electron__ipc__llm.test.ts.info
		local name="${1//\//__}"
		cp coverage/lcov.info "$SHARD_DIR/$name.info"
		echo "  OK   $1"
	else
		echo "  MISS $1  (timeout/oom/no-tests)"
	fi
}

# PER-FILE everywhere. We learned per-DIRECTORY shards UNDER-count: when many
# test files share one bun process, mock.module (process-global) + happy-dom DOM
# state bleed across files, so a test covers fewer paths than it does alone
# (verified: src hooks read 72-79% per-dir but 100% per-file). Per-file isolates
# each test; the lcov-parser sums duplicate SF: records across shards, so a
# function covered only by ANOTHER file's test is still credited after merge.
# Cost: ~272 bun runs, ~25-30 min. This is the ACCURATE local path; on Linux CI
# a single `bun test --coverage` is both accurate and fast (no OOM there).
echo "== src PER-FILE =="
for f in $(find src \( -name '*.test.tsx' -o -name '*.test.ts' \) 2>/dev/null); do
	run_shard "$f"
done

echo "== electron PER-FILE (batch mock.module pollution zeroes coverage) =="
for f in $(find electron -name '*.test.ts' -not -path '*/node_modules/*' 2>/dev/null); do
	run_shard "$f"
done

echo "== merge shards (colocated attribution) =="
node scripts/crap/merge-lcov-best.mjs "$SHARD_DIR" coverage/lcov.info
echo "merged: $(grep -c '^SF:' coverage/lcov.info) source files into coverage/lcov.info"

if [ "${1:-}" != "--no-crap" ]; then
	echo "== CRAP report =="
	bun run scripts/crap.ts --skip-coverage --json reports/crap.json --top 25
	echo
	echo "Regression gate (vs reports/crap-baseline.json):"
	bun run scripts/crap-gate.ts reports/crap-baseline.json reports/crap.json || true
fi
