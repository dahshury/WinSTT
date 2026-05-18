"""Cover the lazy ``__getattr__`` on the synthesizer package.

``src.synthesizer.__getattr__`` defers importing ``KokoroSynthesizer``
(which pulls in the optional ``kokoro_onnx`` wheel) so the package parses
in test/typecheck environments that don't ship it. Both branches —
the lazy-import name and the unknown-name ``AttributeError`` — are pinned
here.
"""

from __future__ import annotations

import importlib

import pytest

import src.synthesizer as synth_pkg


def test_unknown_attribute_raises_attribute_error() -> None:
    with pytest.raises(AttributeError, match="definitely_not_a_real_symbol"):
        _ = synth_pkg.definitely_not_a_real_symbol  # type: ignore[attr-defined]


def test_kokoro_synthesizer_lazy_path_is_exercised() -> None:
    """Accessing ``KokoroSynthesizer`` triggers the lazy infra import.

    ``kokoro_onnx`` is an optional wheel not installed in the test venv,
    so the import inside the branch raises ``ModuleNotFoundError`` — but
    the branch body still executes (the point of this coverage test). If
    the wheel *is* present, the attribute resolves to the class instead.
    """
    try:
        obj = synth_pkg.KokoroSynthesizer
    except ModuleNotFoundError as exc:
        assert "kokoro_onnx" in str(exc) or "kokoro" in str(exc)
    else:
        assert obj.__name__ == "KokoroSynthesizer"


def test_dunder_getattr_is_the_module_hook() -> None:
    # Guard against the hook being accidentally removed/renamed in a
    # refactor — the lazy surface depends on it existing.
    mod = importlib.import_module("src.synthesizer")
    assert callable(mod.__getattr__)
