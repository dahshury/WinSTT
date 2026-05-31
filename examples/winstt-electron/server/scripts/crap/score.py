"""CRAP score formula. Mirrors `frontend/scripts/crap/score.ts`.

    CRAP = CC^2 * (1 - coverage)^3 + CC

    - ``CC`` is cyclomatic complexity (the function body's branch count)
    - ``coverage`` is line coverage as a fraction in [0, 1]

Returns None when coverage is unknown (function not in the coverage report).
"""

from __future__ import annotations


def calculate_crap_score(complexity: int, coverage_fraction: float | None) -> float | None:
    if coverage_fraction is None:
        return None
    cc = float(complexity)
    uncovered = 1.0 - coverage_fraction
    return cc * cc * (uncovered * uncovered * uncovered) + cc
