#!/usr/bin/env python
"""Entrypoint for the server CRAP analyzer.

Python port of `frontend/scripts/crap.ts`. Pipeline:

  1. Run `uv run pytest --cov-report=json:reports/crap-coverage.json`
     (refresh coverage) unless --skip-coverage is passed.
  2. Parse the coverage JSON -> per-file executed/missing line sets.
  3. Walk every `src/**/*.py` (honoring `[tool.coverage.run].omit` and an
     optional `crap.ignore.json`), computing per-function cyclomatic
     complexity from the AST.
  4. For each function, derive line coverage and compute
     CRAP = CC^2 * (1 - cov)^3 + CC.
  5. Print a report; exit non-zero if --strict and any function is at or
     above the threshold (default 4).

Usage (from server/):
  uv run python scripts/crap.py                  # full analysis, threshold 4
  uv run python scripts/crap.py --threshold 8
  uv run python scripts/crap.py --top 50
  uv run python scripts/crap.py --skip-coverage  # reuse existing coverage JSON
  uv run python scripts/crap.py --strict         # exit 1 if any over threshold
  uv run python scripts/crap.py --json out.json  # also emit a JSON report
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from crap.analyzer import analyze, read_coverage_omit, read_crap_ignore
from crap.coverage_parser import parse_coverage
from crap.formatter import format_report

PROJECT_ROOT = Path(__file__).resolve().parent.parent
COVERAGE_JSON = PROJECT_ROOT / "reports" / "crap-coverage.json"


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="crap.py", description="Server CRAP analyzer")
    p.add_argument("--threshold", type=float, default=4.0)
    p.add_argument("--top", type=int, default=25)
    p.add_argument("--skip-coverage", action="store_true")
    p.add_argument("--strict", action="store_true")
    p.add_argument("--json", dest="json_out", default=None)
    return p.parse_args(argv)


def main() -> int:
    args = parse_args(sys.argv[1:])

    if not args.skip_coverage:
        print("Running test suite with coverage...")
        COVERAGE_JSON.parent.mkdir(parents=True, exist_ok=True)
        mtime_before = COVERAGE_JSON.stat().st_mtime if COVERAGE_JSON.exists() else 0.0
        result = subprocess.run(
            [
                "uv",
                "run",
                "pytest",
                f"--cov-report=json:{COVERAGE_JSON}",
            ],
            cwd=PROJECT_ROOT,
            check=False,
        )
        fresh = COVERAGE_JSON.exists() and COVERAGE_JSON.stat().st_mtime > mtime_before
        # pytest exits non-zero when `fail_under=100` isn't met even though
        # every test passed AND the coverage JSON was still written. Only
        # abort when the JSON is missing/stale (a real test failure +
        # `--no-cov-on-fail` suppression).
        if result.returncode != 0:
            if fresh:
                print(
                    f"WARNING: pytest exited {result.returncode} "
                    "(likely fail_under not met); coverage JSON is fresh, continuing.",
                    file=sys.stderr,
                )
            else:
                print(
                    f"pytest exited with code {result.returncode} and produced no "
                    "fresh coverage JSON (test failure + `--no-cov-on-fail`). Aborting.",
                    file=sys.stderr,
                )
                return 1

    if not COVERAGE_JSON.exists():
        print(f"Coverage JSON not found: {COVERAGE_JSON}", file=sys.stderr)
        return 1

    coverage = parse_coverage(COVERAGE_JSON, PROJECT_ROOT)

    omit = read_coverage_omit(PROJECT_ROOT)
    if omit:
        print(f"Excluding {len(omit)} coverage-omit path(s):\n  " + "\n  ".join(omit))
    crap_ignore = read_crap_ignore(PROJECT_ROOT)
    if crap_ignore:
        print(f"Excluding {len(crap_ignore)} crap-ignore path(s):\n  " + "\n  ".join(crap_ignore))

    metrics = analyze(
        PROJECT_ROOT,
        coverage,
        roots=["src"],
        exclude_paths=[*omit, *crap_ignore],
    )

    print(format_report(metrics, threshold=args.threshold, top_n=args.top))

    if args.json_out:
        out_path = PROJECT_ROOT / args.json_out
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(
            json.dumps([dataclasses.asdict(m) for m in metrics], indent=2) + "\n",
            encoding="utf-8",
        )

    if args.strict:
        over = [m for m in metrics if (m.crap or 0.0) >= args.threshold]
        if over:
            print(f"\nFAIL: {len(over)} functions >= CRAP {args.threshold}", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
