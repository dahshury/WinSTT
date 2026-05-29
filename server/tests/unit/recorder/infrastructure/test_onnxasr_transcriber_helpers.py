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
    _build_sess_options,
    _extract_fp16_whisper_decoder_path,
    _find_whisper_vocab_holder,
    _is_external_data_missing_error,
    _is_whisper_family,
    _load_whisper_base_vocab,
    _make_progress_adapter,
    _optimized_model_path,
    _peak_normalize,
    _pick_intra_op_threads,
    _repair_whisper_vocab,
    _slug_model_id,
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


def test_is_external_data_missing_error_windows_missing_shard() -> None:
    """Windows ORT phrases a missing sharded sidecar as a failed ``file_size``
    call, not as ``External data path does not exist`` — the auto-refetch must
    still fire. This is the exact cohere-transcribe fp16 failure."""
    exc = RuntimeError(
        "Exception during initialization: file_size: The system cannot find the "
        'file specified.: "C:\\Users\\x\\.cache\\huggingface\\hub\\models--onnx-'
        "community--cohere-transcribe-03-2026-ONNX\\snapshots\\abc\\onnx\\"
        'encoder_model_fp16.onnx_data_1"'
    )
    assert _is_external_data_missing_error(exc) is True


def test_is_external_data_missing_error_posix_missing_sidecar() -> None:
    exc = FileNotFoundError("No such file or directory: '/cache/onnx/encoder_model.onnx.data'")
    assert _is_external_data_missing_error(exc) is True


def test_is_external_data_missing_error_filenotfound_unrelated_path_negative() -> None:
    """A file-not-found that is *not* about an ONNX sidecar must not trigger a
    refetch — guards against firing on, say, a missing config or tokenizer."""
    exc = RuntimeError("The system cannot find the file specified.: 'tokenizer.json'")
    assert _is_external_data_missing_error(exc) is False


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
#
# Post-Option-C the cache key collapses to a constant CPU sentinel — Silero
# VAD is unconditionally loaded on CPU regardless of the parent transcriber's
# providers (the GPU-side load deadlocked against the CUDA default stream
# when paired with ``do_copy_in_default_stream=1``). These tests pin that
# invariant so any regression that re-introduces per-provider keying — and
# with it the deadlock risk — fails loudly here first.


def test_vad_cache_key_for_none_returns_cpu_sentinel() -> None:
    assert _vad_cache_key(None) == ("CPUExecutionProvider",)


def test_vad_cache_key_ignores_cpu_providers_input() -> None:
    """Passing the same CPU tuple still returns the canonical sentinel."""
    assert _vad_cache_key(("CPUExecutionProvider",)) == ("CPUExecutionProvider",)


def test_vad_cache_key_ignores_gpu_providers_input() -> None:
    """GPU providers are silently ignored — Silero ALWAYS loads on CPU.
    This is the architectural invariant that fixes the deadlock; if a
    future change leaks GPU providers through, we want a test failure,
    not a silent renderer hang."""
    cpu_key = _vad_cache_key(("CPUExecutionProvider",))
    cuda_key = _vad_cache_key(("CUDAExecutionProvider", "CPUExecutionProvider"))
    # Both inputs collapse to the same CPU sentinel — single cache slot,
    # one Silero instance for the entire process.
    assert cpu_key == cuda_key == ("CPUExecutionProvider",)
    # Key still hashable (used as a dict key).
    _round_trip = {cpu_key: 1}
    assert _round_trip[cpu_key] == 1


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


# ── _pick_intra_op_threads / _build_sess_options ───────────────────────


def test_pick_intra_op_threads_gpu_provider_returns_two() -> None:
    """GPU EPs only need ~2 host threads; over-provisioning hurts (-49 %
    measured on Canary-180M / CUDA). Verify every GPU-class provider is
    classified."""
    for gpu_provider in (
        "CUDAExecutionProvider",
        "DmlExecutionProvider",
        "ROCMExecutionProvider",
        "CoreMLExecutionProvider",
    ):
        assert _pick_intra_op_threads((gpu_provider,)) == 2


def test_pick_intra_op_threads_gpu_with_options_tuple() -> None:
    """ORT lets providers be ``(name, options_dict)`` tuples — must still
    be classified as GPU."""
    providers = (("CUDAExecutionProvider", {"device_id": "0"}),)
    assert _pick_intra_op_threads(providers) == 2


def test_pick_intra_op_threads_cpu_caps_at_eight() -> None:
    """CPU EP on the actual host: never exceed 8, to dodge E-core
    collapse on hybrid CPUs (measured 10x worse at intra=10 on Alder Lake)."""
    threads = _pick_intra_op_threads(("CPUExecutionProvider",))
    assert 2 <= threads <= 8


def test_build_sess_options_sets_intra_threads_for_cpu() -> None:
    opts = _build_sess_options(("CPUExecutionProvider",), fp16=False)
    assert 2 <= opts.intra_op_num_threads <= 8


def test_build_sess_options_sets_intra_threads_for_gpu() -> None:
    opts = _build_sess_options(("CUDAExecutionProvider",), fp16=False)
    assert opts.intra_op_num_threads == 2


def test_build_sess_options_fp16_lowers_graph_optimization() -> None:
    """Legacy unparametrized fp16 path (model_name=None) keeps
    ``ORT_ENABLE_EXTENDED`` (workaround for Whisper fp16 encoder fusion
    bug) — see :func:`_build_sess_options` docstring."""
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=True)
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED


def test_build_sess_options_non_fp16_keeps_default_graph_level() -> None:
    """Non-fp16 path leaves graph_optimization_level at ORT default
    (ORT_ENABLE_ALL), to keep every fusion the export can survive."""
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=False)
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_ALL


# ── Per-model fp16 gate (sub-goal 1 from Axis IV.1) ─────────────────────
#
# The ``ORT_ENABLE_EXTENDED`` downgrade exists to dodge a
# ``SimplifiedLayerNormFusion`` bug on legacy onnx-community Whisper fp16
# encoder exports. Parakeet, Moonshine, Canary, and other non-Whisper
# fp16 models don't have this bug and keep ``ORT_ENABLE_ALL`` for the
# full fusion savings (5-10 % per inference). The gate is purely
# string-based on the model name — see :func:`_is_whisper_family`.


def test_is_whisper_family_matches_canonical_whisper() -> None:
    assert _is_whisper_family("whisper-tiny.en") is True
    assert _is_whisper_family("whisper-large-v3") is True


def test_is_whisper_family_matches_lite_and_distil_variants() -> None:
    """Variants we still consider Whisper-family — same fp16 bug applies."""
    assert _is_whisper_family("lite-whisper-acc") is True
    assert _is_whisper_family("distil-whisper-large-v3") is True


def test_is_whisper_family_matches_onnx_community_repo_prefix() -> None:
    """The HF org/repo form must still be classified."""
    assert _is_whisper_family("onnx-community/whisper-tiny.en") is True


def test_is_whisper_family_is_case_insensitive() -> None:
    assert _is_whisper_family("Whisper-Tiny") is True


def test_is_whisper_family_rejects_non_whisper_models() -> None:
    """Non-Whisper families MUST not be classified — that's what
    unlocks the ORT_ENABLE_ALL win for them."""
    assert _is_whisper_family("nemo-parakeet-tdt-0.6b-v3") is False
    assert _is_whisper_family("moonshine-base") is False
    assert _is_whisper_family("nemo-canary-1b-v2") is False
    assert _is_whisper_family("gigaam-v2-rnnt") is False
    assert _is_whisper_family("cohere_asr_v1") is False


def test_is_whisper_family_handles_empty_or_none() -> None:
    assert _is_whisper_family(None) is False
    assert _is_whisper_family("") is False


def test_build_sess_options_fp16_with_whisper_drops_to_extended() -> None:
    """Whisper fp16 with the model_name known: still downgrades."""
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=True, model_name="whisper-tiny.en")
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED


def test_build_sess_options_fp16_with_parakeet_keeps_enable_all() -> None:
    """The core Axis IV.1 assertion: non-Whisper fp16 KEEPS full
    fusions — recovers 5-10 % per inference on those models."""
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=True, model_name="nemo-parakeet-tdt-0.6b-v3")
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_ALL


def test_build_sess_options_fp16_with_moonshine_keeps_enable_all() -> None:
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=True, model_name="moonshine-base")
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_ALL


def test_build_sess_options_fp16_with_canary_keeps_enable_all() -> None:
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=True, model_name="nemo-canary-1b-v2")
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_ALL


def test_build_sess_options_fp16_with_lite_whisper_drops_to_extended() -> None:
    """Lite-Whisper IS a Whisper variant — the fp16 bug still applies."""
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=True, model_name="lite-whisper-acc")
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED


def test_build_sess_options_non_fp16_with_whisper_keeps_enable_all() -> None:
    """fp16=False bypasses the gate entirely regardless of model."""
    import onnxruntime as rt

    opts = _build_sess_options(("CPUExecutionProvider",), fp16=False, model_name="whisper-tiny.en")
    assert opts.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_ALL


# ── Optimized-model cache path (sub-goal 3 from Axis IV.3) ──────────────


def test_slug_model_id_replaces_unsafe_characters() -> None:
    """HF org/repo and quant tags must collapse to a filesystem-safe stem."""
    slug = _slug_model_id("onnx-community/whisper-tiny.en", "fp16")
    # Slashes, colons, etc. are squashed to ``_``.
    assert "/" not in slug
    assert "onnx-community_whisper-tiny.en" in slug
    assert "fp16" in slug


def test_slug_model_id_embeds_quantization() -> None:
    """Different quants of the same model must NOT collide."""
    a = _slug_model_id("whisper-tiny", "fp16")
    b = _slug_model_id("whisper-tiny", "int8")
    assert a != b


def test_slug_model_id_defaults_quantization_to_default() -> None:
    """Empty/None quantization slugs as ``default`` for stable keys."""
    a = _slug_model_id("whisper-tiny", None)
    b = _slug_model_id("whisper-tiny", "")
    assert a == b
    assert "default" in a


def test_optimized_model_path_includes_ort_version(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Cache key MUST embed ``onnxruntime.__version__`` so a wheel bump
    invalidates the cache automatically (no incompatible-graph crashes)."""
    import onnxruntime as rt

    monkeypatch.setenv("WINSTT_ORT_CACHE_DIR", str(tmp_path))
    path = _optimized_model_path("whisper-tiny", "fp16")
    assert path is not None
    assert rt.__version__ in str(path)
    assert path.name.endswith(".ort.bin")
    # Parent directory must exist after resolution (created on demand).
    assert path.parent.is_dir()


def test_optimized_model_path_idempotent(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Calling twice with the same arguments returns the same path so
    a second session load writes to the same place (cache reuse)."""
    monkeypatch.setenv("WINSTT_ORT_CACHE_DIR", str(tmp_path))
    first = _optimized_model_path("whisper-tiny", "fp16")
    second = _optimized_model_path("whisper-tiny", "fp16")
    assert first == second


def test_optimized_model_path_distinct_per_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Different models MUST hash to distinct cache files."""
    monkeypatch.setenv("WINSTT_ORT_CACHE_DIR", str(tmp_path))
    a = _optimized_model_path("whisper-tiny", "fp16")
    b = _optimized_model_path("nemo-parakeet-tdt-0.6b-v3", "fp16")
    assert a != b


def test_build_sess_options_optimize_to_disk_sets_filepath(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """With ``optimize_to_disk=True``, the SessionOptions exposes a
    cache path that includes the ORT version (so ORT will serialize
    the optimized graph on session creation)."""
    import onnxruntime as rt

    monkeypatch.setenv("WINSTT_ORT_CACHE_DIR", str(tmp_path))
    opts = _build_sess_options(
        ("CPUExecutionProvider",),
        fp16=False,
        model_name="whisper-tiny",
        quantization="fp16",
        optimize_to_disk=True,
    )
    assert opts.optimized_model_filepath
    assert rt.__version__ in opts.optimized_model_filepath


def test_build_sess_options_optimize_to_disk_default_off(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Default ``optimize_to_disk=False`` leaves the field blank — no
    accidental disk writes for callers that don't opt in."""
    monkeypatch.setenv("WINSTT_ORT_CACHE_DIR", str(tmp_path))
    opts = _build_sess_options(
        ("CPUExecutionProvider",),
        fp16=False,
        model_name="whisper-tiny",
        quantization="fp16",
    )
    assert not opts.optimized_model_filepath


def test_build_sess_options_optimize_to_disk_requires_model_name(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """No model_name → no cache key → no filepath (best-effort
    fail-quiet path)."""
    monkeypatch.setenv("WINSTT_ORT_CACHE_DIR", str(tmp_path))
    opts = _build_sess_options(
        ("CPUExecutionProvider",),
        fp16=False,
        model_name=None,
        quantization="fp16",
        optimize_to_disk=True,
    )
    assert not opts.optimized_model_filepath


# ── whisper vocab repair (CrisperWhisper truncated-export fix) ───────────


class _FakeWhisperHolder:
    """Minimal stand-in for onnx_asr's WhisperHf — the repair finder keys on a
    dict ``_vocab`` paired with a ``_byte_decoder``."""

    def __init__(self, vocab: dict[int, str]) -> None:
        self._vocab = vocab
        self._byte_decoder = {"a": 1}


class _FakeAdapter:
    """Wraps the holder one level deep, like the TextResultsAsrAdapter onnx_asr
    returns from load_model."""

    def __init__(self, holder: object) -> None:
        self._model = holder


def test_load_whisper_base_vocab_is_complete_and_has_fillers() -> None:
    """The bundled reference decodes the CrisperWhisper filler ids that its own
    truncated vocab.json drops (35007 = ' uhm', 35481 = ' hm')."""
    ref = _load_whisper_base_vocab()
    assert len(ref) >= 50_000
    assert ref.get(35007) == "Ġuhm"
    assert ref.get(35481) == "Ġhm"


def test_find_whisper_vocab_holder_walks_to_holder() -> None:
    holder = _FakeWhisperHolder({0: "a"})
    assert _find_whisper_vocab_holder(_FakeAdapter(holder)) is holder


def test_find_whisper_vocab_holder_none_for_non_whisper() -> None:
    """A dict ``_vocab`` WITHOUT a ``_byte_decoder`` is not a Whisper holder —
    other families (CTC/RNN-T) must be skipped so the repair never touches them."""

    class _NotWhisper:
        def __init__(self) -> None:
            self._vocab = {0: "a"}  # no _byte_decoder

    assert _find_whisper_vocab_holder(_NotWhisper()) is None


def test_repair_whisper_vocab_backfills_missing_ids() -> None:
    """An incomplete Whisper vocab gets the missing base ids backfilled from the
    bundled reference; existing entries are preserved."""
    holder = _FakeWhisperHolder({0: "kept"})
    _repair_whisper_vocab(_FakeAdapter(holder))
    assert holder._vocab[0] == "kept"  # not clobbered
    assert holder._vocab.get(35007) == "Ġuhm"
    assert holder._vocab.get(35481) == "Ġhm"
    assert len(holder._vocab) >= 50_000


def test_repair_whisper_vocab_noop_when_complete() -> None:
    """A vocab that already contains the reference ids is left byte-identical."""
    ref = dict(_load_whisper_base_vocab())
    holder = _FakeWhisperHolder(ref)
    before = len(holder._vocab)
    _repair_whisper_vocab(_FakeAdapter(holder))
    assert len(holder._vocab) == before


def test_repair_whisper_vocab_noop_for_non_whisper() -> None:
    """Non-Whisper models (no holder) are a silent no-op — never raises."""

    class _NotWhisper:
        pass

    _repair_whisper_vocab(_NotWhisper())  # must not raise
