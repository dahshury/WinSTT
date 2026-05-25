"""Wrapper-level tests for pure-function helpers in
:mod:`src.recorder.infrastructure.onnxasr_transcriber`.

These helpers are the glue layer the ML library never sees:

* ``_peak_normalize`` — scalar gain to 0.95 full-scale.
* ``_extract_fp16_whisper_decoder_path`` — regex classifier over ORT errors.
* ``_is_external_data_missing_error`` — substring classifier.
* ``_vad_cache_key`` — stable hashable key for the Silero VAD cache.
* ``_make_progress_adapter`` — onnx-asr progress → server DownloadProgress
  aggregation.
* ``_snapshot_providers`` — duck-typed walk to discover ORT providers.

No ML library is loaded; helpers are tested in isolation.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from src.recorder.domain.events import DownloadProgress
from src.recorder.infrastructure.onnxasr_transcriber import (
    _extract_fp16_whisper_decoder_path,
    _is_external_data_missing_error,
    _make_progress_adapter,
    _peak_normalize,
    _snapshot_providers,
    _vad_cache_key,
)

# ── _peak_normalize ─────────────────────────────────────────────────────


def test_peak_normalize_empty_array_returns_as_is() -> None:
    audio: np.ndarray = np.zeros(0, dtype=np.float32)
    out = _peak_normalize(audio)
    assert out.size == 0


def test_peak_normalize_all_zero_returns_unchanged() -> None:
    """Silent buffer (peak == 0) must not divide by zero — pass through."""
    audio = np.zeros(1024, dtype=np.float32)
    out = _peak_normalize(audio)
    assert np.array_equal(out, audio)


def test_peak_normalize_scales_to_target_peak() -> None:
    audio = np.array([0.1, -0.2, 0.05, -0.1], dtype=np.float32)
    out = _peak_normalize(audio)
    assert float(np.max(np.abs(out))) == pytest.approx(0.95)


def test_peak_normalize_already_loud_signal_scales_down() -> None:
    audio = np.array([0.9, -1.5, 0.3], dtype=np.float32)
    out = _peak_normalize(audio)
    # 1.5 is the peak → out should be (audio / 1.5) * 0.95.
    assert float(np.max(np.abs(out))) == pytest.approx(0.95)
    assert out.dtype == np.float32


def test_peak_normalize_returns_float32() -> None:
    audio = np.array([0.1, -0.2], dtype=np.float32)
    assert _peak_normalize(audio).dtype == np.float32


@settings(max_examples=100)
@given(
    arr=st.lists(
        st.floats(min_value=-10.0, max_value=10.0, allow_nan=False, allow_infinity=False),
        min_size=1,
        max_size=64,
    )
)
def test_peak_normalize_never_exceeds_target(arr: list[float]) -> None:
    audio = np.array(arr, dtype=np.float32)
    out = _peak_normalize(audio)
    if float(np.max(np.abs(audio))) > 0.0:
        assert float(np.max(np.abs(out))) <= 0.95 + 1e-5
    else:
        # All-zero input: passes through unchanged.
        assert np.array_equal(out, audio)


# ── Error classifiers ───────────────────────────────────────────────────


def test_extract_fp16_decoder_path_matches_decoder_merged_pattern() -> None:
    exc = RuntimeError(
        "Load model from C:/cache/decoder_model_merged_fp16.onnx failed: "
        "Subgraph output 'logits' refers to an outer scope value"
    )
    result = _extract_fp16_whisper_decoder_path(exc)
    assert result == Path("C:/cache/decoder_model_merged_fp16.onnx")


def test_extract_fp16_decoder_path_returns_none_when_no_match() -> None:
    exc = RuntimeError("something else entirely")
    assert _extract_fp16_whisper_decoder_path(exc) is None


def test_extract_fp16_decoder_path_returns_none_for_non_merged_decoder() -> None:
    """Other ``decoder*.onnx`` files (e.g. the non-merged variant) must
    not be patched by this codepath — only ``decoder_model_merged*``."""
    exc = RuntimeError(
        "Load model from /some/decoder_model.onnx failed: Subgraph output 'logits' refers to an outer scope value"
    )
    assert _extract_fp16_whisper_decoder_path(exc) is None


@settings(max_examples=50)
@given(text=st.text(min_size=0, max_size=200))
def test_extract_fp16_decoder_path_never_crashes_on_random_strings(text: str) -> None:
    """Property: classifier must accept any string without raising."""
    exc = RuntimeError(text)
    _extract_fp16_whisper_decoder_path(exc)  # should not raise


def test_is_external_data_missing_error_positive() -> None:
    exc = FileNotFoundError("External data path does not exist: model.onnx.data")
    assert _is_external_data_missing_error(exc) is True


def test_is_external_data_missing_error_negative() -> None:
    exc = RuntimeError("Some unrelated ORT failure")
    assert _is_external_data_missing_error(exc) is False


@settings(max_examples=50)
@given(text=st.text(min_size=0, max_size=200))
def test_external_data_classifier_never_crashes(text: str) -> None:
    exc = RuntimeError(text)
    result = _is_external_data_missing_error(exc)
    assert isinstance(result, bool)


# ── _vad_cache_key ──────────────────────────────────────────────────────


def test_vad_cache_key_for_none_is_sentinel() -> None:
    assert _vad_cache_key(None) == ("__default__",)


def test_vad_cache_key_round_trips_tuple() -> None:
    providers = ("CPUExecutionProvider",)
    assert _vad_cache_key(providers) == providers


def test_vad_cache_key_different_tuples_are_distinct() -> None:
    """Two distinct provider sets MUST hash to distinct cache keys —
    otherwise CPU and GPU VAD sessions would collide."""
    cpu_key = _vad_cache_key(("CPUExecutionProvider",))
    cuda_key = _vad_cache_key(("CUDAExecutionProvider", "CPUExecutionProvider"))
    assert cpu_key != cuda_key
    # Both keys must be hashable (they're used as dict keys).
    _round_trip = {cpu_key: 1, cuda_key: 2}
    assert _round_trip[cpu_key] == 1
    assert _round_trip[cuda_key] == 2


# ── _make_progress_adapter ──────────────────────────────────────────────


class _FakeProgressEvent:
    def __init__(self, filename: str, downloaded: int, total: int) -> None:
        self.filename = filename
        self.downloaded = downloaded
        self.total = total


def test_progress_adapter_aggregates_across_files() -> None:
    received: list[DownloadProgress] = []
    adapter = _make_progress_adapter("whisper-base", received.append)

    adapter(_FakeProgressEvent("a.onnx", downloaded=500, total=1000))
    adapter(_FakeProgressEvent("b.onnx.data", downloaded=200, total=2000))
    # Bump file ``a`` to 100 % — the aggregate should reflect both files.
    adapter(_FakeProgressEvent("a.onnx", downloaded=1000, total=1000))

    last = received[-1]
    assert last.model == "whisper-base"
    assert last.downloaded_bytes == 1200  # 1000 + 200
    assert last.total_bytes == 3000  # 1000 + 2000
    assert last.progress == pytest.approx(1200 / 3000)


def test_progress_adapter_handles_total_zero() -> None:
    """Some onnx-asr events carry ``total=None`` (or 0) early — we treat
    them as zero. Progress is reported as 0 in that case (avoids divide-by-zero)."""
    received: list[DownloadProgress] = []
    adapter = _make_progress_adapter("whisper-base", received.append)

    adapter(_FakeProgressEvent("a.onnx", downloaded=0, total=0))
    assert received[-1].progress == 0.0


def test_progress_adapter_event_carries_model_name() -> None:
    received: list[DownloadProgress] = []
    adapter = _make_progress_adapter("my-special-model", received.append)
    adapter(_FakeProgressEvent("a.onnx", downloaded=10, total=100))
    assert received[-1].model == "my-special-model"


# ── _snapshot_providers ─────────────────────────────────────────────────


def test_snapshot_providers_finds_decoder() -> None:
    """A model with a ``_decoder`` session whose ``get_providers()`` returns
    a list — that list (stringified) must be the snapshot."""

    class FakeDecoder:
        def get_providers(self) -> list[str]:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    fake_model = MagicMock()
    fake_model.asr = MagicMock()
    fake_model.asr._decoder = FakeDecoder()
    fake_model.asr.decoder = None
    fake_model.asr._encoder = None
    fake_model.asr.encoder = None
    fake_model.asr._model = None

    providers = _snapshot_providers(fake_model)
    assert providers == ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_snapshot_providers_returns_empty_when_no_session_walkable() -> None:
    """A bare object with no inspectable sessions — must NOT crash; returns []."""

    class Empty:
        pass

    providers = _snapshot_providers(Empty())
    assert providers == []


def test_snapshot_providers_handles_get_providers_raising() -> None:
    """If ``get_providers()`` raises, we fall through to the next session candidate."""

    class CrashyDecoder:
        def get_providers(self) -> list[str]:
            msg = "session not ready"
            raise RuntimeError(msg)

    class GoodEncoder:
        def get_providers(self) -> list[str]:
            return ["CPUExecutionProvider"]

    class _AsrLike:
        _decoder = CrashyDecoder()
        decoder = None
        _encoder = GoodEncoder()

    class _Outer:
        asr = _AsrLike()

    providers = _snapshot_providers(_Outer())
    assert providers == ["CPUExecutionProvider"]


def test_snapshot_providers_walks_attributes_when_named_sessions_missing() -> None:
    """If none of the canonical names match but some other attribute has a
    ``get_providers()``, the generic walk over ``vars()`` picks it up."""

    class GenericSession:
        def get_providers(self) -> list[str]:
            return ["AzureExecutionProvider"]

    class _Asr:
        def __init__(self) -> None:
            # Instance attribute so ``vars()`` (used by the generic walk) sees it.
            self.random_session = GenericSession()

    fake = MagicMock()
    fake.asr = _Asr()

    providers = _snapshot_providers(fake)
    assert "AzureExecutionProvider" in providers
