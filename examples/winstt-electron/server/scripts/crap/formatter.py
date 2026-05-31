"""Report formatter. Mirrors `frontend/scripts/crap/formatter.ts`.

Renders: counts header, top-N worst offenders, distribution histogram,
and the count of functions with no coverage data.
"""

from __future__ import annotations

from .analyzer import FunctionMetric


def _pad(s: str, width: int) -> str:
    return s if len(s) >= width else s + " " * (width - len(s))


def format_report(metrics: list[FunctionMetric], *, threshold: float, top_n: int) -> str:
    lines: list[str] = []
    total = len(metrics)
    with_cov = [m for m in metrics if m.crap is not None]
    over = [m for m in with_cov if (m.crap or 0.0) >= threshold]

    lines.append(f"# CRAP Analysis (threshold >= {threshold})")
    lines.append("")
    lines.append(f"Functions analyzed: {total}")
    lines.append(f"Functions with coverage data: {len(with_cov)}")
    lines.append(f"Functions over threshold: {len(over)}")
    lines.append("")

    lines.append(f"## Top {top_n} worst CRAP scores")
    lines.append("")
    top = sorted(with_cov, key=lambda m: m.crap or 0.0, reverse=True)[:top_n]
    if not top:
        lines.append("(no functions with coverage data)")
    else:
        w = {"crap": 8, "cc": 4, "cov": 6, "loc": 9}
        lines.append(
            f"{_pad('CRAP', w['crap'])}  {_pad('CC', w['cc'])}  "
            f"{_pad('Cov%', w['cov'])}  {_pad('Lines', w['loc'])}  Function"
        )
        lines.append("-" * 80)
        for m in top:
            cov = "-" if m.coverage is None else f"{m.coverage * 100:.1f}"
            lines.append(
                "  ".join(
                    [
                        _pad(f"{m.crap or 0.0:.2f}", w["crap"]),
                        _pad(str(m.complexity), w["cc"]),
                        _pad(cov, w["cov"]),
                        _pad(f"{m.start_line}-{m.end_line}", w["loc"]),
                        f"{m.file} :: {m.name}",
                    ]
                )
            )

    lines.append("")
    lines.append("## Distribution")
    lines.append("")
    buckets = [
        ("CRAP < 4 (clean)", 0.0, 4.0),
        ("4 <= CRAP < 8", 4.0, 8.0),
        ("8 <= CRAP < 30", 8.0, 30.0),
        ("CRAP >= 30 (crisis)", 30.0, float("inf")),
    ]
    for label, lo, hi in buckets:
        count = sum(1 for m in with_cov if lo <= (m.crap or 0.0) < hi)
        pct = (100.0 * count / len(with_cov)) if with_cov else 0.0
        lines.append(f"  {_pad(label, 22)} {_pad(str(count), 5)}  {pct:.1f}%")

    lines.append("")
    lines.append("## Functions without coverage data")
    uncovered = [m for m in metrics if m.coverage is None]
    lines.append(
        f"  {len(uncovered)} functions (no executable coverage lines in span "
        "- likely abstract, type-only, or unreachable)"
    )

    return "\n".join(lines)
