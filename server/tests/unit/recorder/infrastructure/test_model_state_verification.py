"""The picker's cache verdict must match what an actual swap downloads — for
EVERY family, not just the int8-preferred ones.

The fast ``*.onnx`` glob heuristic only sees weight files; it can't tell that a
load also needs ``vocab.txt`` / ``tokens.txt`` / ``config.json`` / a second
decoder graph / a ``.onnx_data`` sidecar. If any of those is missing the badge
would paint "Downloaded" and the swap would silently fetch the rest. These
tests lock in the authoritative cross-check: any heuristic ``cached`` is
verified against the loader's own resolver and demoted to ``partial`` when a
load would still download.
"""

from __future__ import annotations

import pytest

from src.recorder.domain.model_registry import ModelCatalog
from src.recorder.infrastructure import model_cache, model_state
from src.recorder.infrastructure.model_cache import (
    ModelCacheState,
    onnx_asr_would_download,
    would_download_on_load,
)


def _model(model_id: str) -> object:
    model = ModelCatalog().get(model_id)
    assert model is not None, f"catalog must still ship {model_id}"
    return model


class TestVerifyQuantCache:
    def test_not_cached_is_returned_untouched_without_a_resolver_call(self, monkeypatch: pytest.MonkeyPatch) -> None:
        called = False

        def _boom(*_args: object, **_kwargs: object) -> bool | None:
            nonlocal called
            called = True
            return True

        monkeypatch.setattr(model_state, "would_download_on_load", _boom)
        state = ModelCacheState(state="not_cached")
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result is state
        assert called is False, "partial/not_cached must skip the authoritative check"

    def test_cached_is_demoted_to_partial_when_a_load_would_download(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: True)
        state = ModelCacheState(state="cached", downloaded_bytes=500, total_bytes=500)
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result.state == "partial"
        assert result.downloaded_bytes == 500
        assert result.total_bytes > result.downloaded_bytes  # progress < 100%

    def test_cached_stays_cached_when_the_loader_confirms_all_files_present(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: False)
        state = ModelCacheState(state="cached", downloaded_bytes=500, total_bytes=500)
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result is state

    def test_cached_stays_cached_when_verdict_is_undeterminable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(model_state, "would_download_on_load", lambda *a, **k: None)
        state = ModelCacheState(state="cached", downloaded_bytes=1, total_bytes=1)
        result = model_state._verify_quant_cache(_model("nemo-canary-1b-flash"), "int8", state)  # type: ignore[arg-type]
        assert result is state


class TestWouldDownloadOnLoad:
    def test_custom_local_bundle_never_downloads(self) -> None:
        assert would_download_on_load("slug", local_path="C:/models/x", quantization="int8") is False

    def test_missing_model_name_is_undeterminable(self) -> None:
        assert would_download_on_load(None, local_path=None, quantization="") is None

    def test_every_family_uses_the_onnx_asr_resolver(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # SenseVoice included — it now has its own onnx-asr model class, so the
        # single resolver check covers it (no bespoke branch).
        monkeypatch.setattr(model_cache, "onnx_asr_would_download", lambda name, quant: True)
        assert (
            would_download_on_load("istupakov/canary-1b-flash-onnx", local_path=None, quantization="q4") is True
        )
        assert (
            would_download_on_load("sense-voice-small", local_path=None, quantization="int8") is True
        )


class TestOnnxAsrResolverProbe:
    def test_unpublished_quant_is_flagged_as_would_download(self) -> None:
        # canary publishes only ["", "int8"]; q4 weights never exist on disk, so
        # the offline resolver must report a load would fetch them.
        assert onnx_asr_would_download("istupakov/canary-1b-flash-onnx", "q4") is True

    def test_missing_onnx_asr_is_undeterminable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import builtins

        real_import = builtins.__import__

        def _no_onnx_asr(name: str, *args: object, **kwargs: object) -> object:
            if name == "onnx_asr.loader" or name.startswith("onnx_asr"):
                raise ImportError(name)
            return real_import(name, *args, **kwargs)

        monkeypatch.setattr(builtins, "__import__", _no_onnx_asr)
        assert onnx_asr_would_download("istupakov/canary-1b-flash-onnx", "int8") is None
