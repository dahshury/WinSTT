"""coverage.py JSON -> per-file executed/missing line sets.

Mirrors `frontend/scripts/crap/lcov-parser.ts`, adapted to the native
coverage.py JSON report (`coverage json` / `pytest --cov-report=json`),
which is richer and more robust than parsing LCOV by hand.

JSON shape we consume:

    {
      "files": {
        "src/recorder/.../foo.py": {
          "executed_lines": [...],
          "missing_lines":  [...]
        }
      }
    }

Files in `[tool.coverage.run].omit` never appear here (coverage already
applied the filter), which dovetails with the analyzer skipping the same
paths during the source walk.
"""

from __future__ import annotations

import contextlib
import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class FileCoverage:
    executed: set[int]
    missing: set[int]


CoverageMap = dict[str, FileCoverage]


def _normalize(raw: str, project_root: Path) -> str:
    p = raw.replace("\\", "/")
    if os.path.isabs(p):
        with contextlib.suppress(ValueError):
            p = Path(p).resolve().relative_to(project_root).as_posix()
    return p


def parse_coverage(coverage_json_path: str | Path, project_root: Path) -> CoverageMap:
    data = json.loads(Path(coverage_json_path).read_text(encoding="utf-8"))
    files = data.get("files", {})
    out: CoverageMap = {}
    for raw_path, info in files.items():
        key = _normalize(raw_path, project_root)
        out[key] = FileCoverage(
            executed=set(info.get("executed_lines", [])),
            missing=set(info.get("missing_lines", [])),
        )
    return out
