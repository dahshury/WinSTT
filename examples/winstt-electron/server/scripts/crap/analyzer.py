"""Orchestrator. Mirrors `frontend/scripts/crap/analyzer.ts`.

Walks every `src/**/*.py` source file, derives per-function complexity +
coverage, then combines them into a CRAP score.

Exclusion model (the Python analog of the frontend's biome-disabled +
crap.ignore.json merge): the project's `[tool.coverage.run].omit` globs in
``pyproject.toml`` already declare what is outside the coverage bar
(infrastructure adapters, bootstrap, client, the WebSocket server, the
terminal shim). We honor that same list so CRAP scope == coverage scope.
An optional ``server/crap.ignore.json`` ({"ignore": [...]}) can add more.
"""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .coverage_parser import CoverageMap
from .method_parser import parse_functions
from .score import calculate_crap_score


@dataclass
class FunctionMetric:
    file: str
    name: str
    start_line: int
    end_line: int
    complexity: int
    coverage: float | None  # fraction in [0, 1]
    crap: float | None


def read_coverage_omit(project_root: Path) -> list[str]:
    """Return `[tool.coverage.run].omit` patterns from pyproject.toml."""
    pyproject = project_root / "pyproject.toml"
    if not pyproject.exists():
        return []
    data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
    omit = data.get("tool", {}).get("coverage", {}).get("run", {}).get("omit", [])
    return [str(p).replace("\\", "/") for p in omit]


def read_crap_ignore(project_root: Path) -> list[str]:
    """Read optional `server/crap.ignore.json` -> its `ignore` array.

    Decouples CRAP scope from coverage config, exactly like the frontend's
    `crap.ignore.json` decouples it from biome. Empty if the file is absent.
    """
    ignore_path = project_root / "crap.ignore.json"
    if not ignore_path.exists():
        return []
    config = json.loads(ignore_path.read_text(encoding="utf-8"))
    return [str(p).replace("\\", "/") for p in config.get("ignore", [])]


def _glob_to_regexp(pattern: str) -> re.Pattern[str]:
    out = ""
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                out += ".*"
                i += 1
            else:
                # coverage.py treats `*` as matching path separators too, so a
                # single `*` here is greedy across slashes (matches its omit
                # semantics, e.g. `src/stt_server/*` -> nested files).
                out += ".*"
        elif ch in r".+?^${}()|[]\\":
            out += "\\" + ch
        else:
            out += ch
        i += 1
    return re.compile(f"^{out}$")


def _path_matches_any(path: str, patterns: list[str]) -> bool:
    for p in patterns:
        if p == path:
            return True
        if p.endswith("/*") and "*" not in p[:-2]:
            if path.startswith(p[:-2] + "/"):
                return True
            continue
        if "*" in p and _glob_to_regexp(p).match(path):
            return True
    return False


def _collect_crap_exclude_lines(text: str) -> set[int]:
    """1-indexed line numbers whose nearest preceding lines carry a
    ``@crap-exclude`` marker (parity with the TS port's annotation scan)."""
    out: set[int] = set()
    for i, line in enumerate(text.splitlines()):
        if "@crap-exclude" in line:
            for j in range(7):
                out.add(i + 1 + j)
    return out


def _function_coverage_fraction(cov_executed: set[int], cov_missing: set[int], start: int, end: int) -> float | None:
    """hit lines / executable lines within [start, end]. Lines outside the
    coverage record set (comments, signatures, type-only code) are treated
    as non-executable. None when the span has no executable lines."""
    executable = 0
    hit = 0
    for ln in range(start, end + 1):
        in_exec = ln in cov_executed
        in_miss = ln in cov_missing
        if not (in_exec or in_miss):
            continue
        executable += 1
        if in_exec:
            hit += 1
    if executable == 0:
        return None
    return hit / executable


def analyze(
    project_root: Path,
    coverage: CoverageMap,
    *,
    roots: list[str],
    exclude_paths: list[str],
) -> list[FunctionMetric]:
    out: list[FunctionMetric] = []
    for root in roots:
        base = project_root / root
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.py")):
            rel = path.relative_to(project_root).as_posix()
            if _path_matches_any(rel, exclude_paths):
                continue
            text = path.read_text(encoding="utf-8")
            excluded_lines = _collect_crap_exclude_lines(text)
            file_cov = coverage.get(rel)
            for fn in parse_functions(rel, text):
                if fn.start_line in excluded_lines:
                    continue
                cov: float | None
                if file_cov is None:
                    cov = None
                else:
                    cov = _function_coverage_fraction(file_cov.executed, file_cov.missing, fn.start_line, fn.end_line)
                out.append(
                    FunctionMetric(
                        file=rel,
                        name=fn.name,
                        start_line=fn.start_line,
                        end_line=fn.end_line,
                        complexity=fn.complexity,
                        coverage=cov,
                        crap=calculate_crap_score(fn.complexity, cov),
                    )
                )
    return out
