"""Python source -> list of FunctionDescriptor (start/end line, cyclomatic complexity).

Mirrors `frontend/scripts/crap/method-parser.ts` (the TS-AST visitor), using
the stdlib ``ast`` module instead of the TypeScript compiler API.

Cyclomatic complexity counts branch nodes per the McCabe definition: each
function body starts at 1 and increments on every place control flow can
fork. Nested functions/lambdas are NOT counted toward the enclosing
function — they get their own descriptor (same rule as the TS port).

Python-specific branch mapping (radon-aligned):

    if / elif / for / while / except / ternary (a if c else b)   -> +1 each
    match case (non-wildcard; ``case _`` is the `default:` analog) -> +1 each
    comprehension generator (implicit loop)                        -> +1 each
    each ``if`` filter inside a comprehension                      -> +1 each
    bool op chain ``a and b and c``                                -> +(n-1)

``with`` / ``try`` / ``assert`` are not branch points (McCabe; matches the TS
port which counts only catch clauses, not try blocks).
"""

from __future__ import annotations

import ast
from dataclasses import dataclass

FunctionLike = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


@dataclass(frozen=True)
class FunctionDescriptor:
    name: str
    start_line: int  # 1-indexed
    end_line: int
    complexity: int


def parse_functions(file_path: str, source: str) -> list[FunctionDescriptor]:
    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError:
        return []
    out: list[FunctionDescriptor] = []
    _visit(tree, out, [])
    return out


def _local_name(node: ast.AST) -> str:
    if isinstance(node, ast.Lambda):
        return "<lambda>"
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return node.name
    return ""


def _visit(node: ast.AST, out: list[FunctionDescriptor], stack: list[str]) -> None:
    is_fn = isinstance(node, FunctionLike)
    is_cls = isinstance(node, ast.ClassDef)

    if is_fn:
        # ``isinstance(node, FunctionLike)`` already narrowed ``node`` for runtime
        # but mypy needs the explicit assert to see ``.lineno`` / ``decorator_list``.
        assert isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))
        local = _local_name(node)
        qualified = ".".join([*stack, local]) if stack else local
        start = node.lineno
        # Fold decorator lines into the span so decorator-line coverage counts.
        decorators: list[ast.expr] = getattr(node, "decorator_list", [])
        if decorators:
            start = min(start, min(d.lineno for d in decorators))
        end = getattr(node, "end_lineno", None) or start
        out.append(
            FunctionDescriptor(
                name=qualified,
                start_line=start,
                end_line=end,
                complexity=_compute_complexity(node),
            )
        )

    child_stack = [*stack, _local_name(node)] if (is_fn or is_cls) else stack
    for child in ast.iter_child_nodes(node):
        _visit(child, out, child_stack)


def _is_wildcard_case(case: ast.match_case) -> bool:
    """``case _:`` (and bare ``case x:`` capture) is the `default:` analog —
    the TS port does not count DefaultClause, so we skip the catch-all too."""
    pat = case.pattern
    return case.guard is None and isinstance(pat, ast.MatchAs) and pat.pattern is None


def _compute_complexity(fn: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> int:
    cc = 1

    def walk(node: ast.AST) -> None:
        nonlocal cc
        # Don't descend into nested functions/lambdas — reported separately.
        if node is not fn and isinstance(node, FunctionLike):
            return

        if isinstance(
            node,
            (ast.If, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler, ast.IfExp),
        ):
            cc += 1
        elif isinstance(node, ast.match_case):
            if not _is_wildcard_case(node):
                cc += 1
        elif isinstance(node, ast.comprehension):
            cc += 1  # the implicit loop
            cc += len(node.ifs)  # each filter predicate
        elif isinstance(node, ast.BoolOp):
            cc += len(node.values) - 1

        for child in ast.iter_child_nodes(node):
            walk(child)

    walk(fn)
    return cc
