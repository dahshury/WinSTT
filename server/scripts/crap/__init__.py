"""CRAP analyzer for the Python server.

Python port of `frontend/scripts/crap/`. Same pipeline, same formula
(CRAP = CC^2 * (1 - cov)^3 + CC), adapted to Python tooling:

  - TS AST  -> stdlib `ast`            (method_parser)
  - LCOV    -> coverage.py JSON        (coverage_parser)
  - biome / crap.ignore.json
            -> `[tool.coverage.run].omit` in pyproject.toml
               (+ optional server/crap.ignore.json)  (analyzer)
"""

from __future__ import annotations
