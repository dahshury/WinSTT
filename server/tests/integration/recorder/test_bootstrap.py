from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

import pytest

from src.building_blocks.errors import ConfigurationError
from src.building_blocks.event_bus import EventBus
from src.recorder.bootstrap import CALLBACK_EVENT_MAP, _validate_language_against_model, wire_callback
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.events import RecordingStarted

if TYPE_CHECKING:
    from src.building_blocks.types import CallbackMap


class TestBootstrap:
    def test_callback_event_map_has_expected_callbacks(self) -> None:
        # The map has grown beyond the original 17 entries (DeviceSwitchFailed,
        # AudioLevelComputed, NoAudioDetected etc. were added later). The exact
        # count is brittle — just verify the map is non-empty and a sampling
        # of well-known callback names are present.
        assert len(CALLBACK_EVENT_MAP) >= 17
        for required in (
            "on_recording_start",
            "on_recording_stop",
            "on_transcription_start",
            "on_realtime_transcription_update",
        ):
            assert required in CALLBACK_EVENT_MAP, f"missing required callback: {required}"

    def test_wire_callback_fires_on_event(self) -> None:
        event_bus = EventBus()
        called: list[bool] = []
        wire_callback(event_bus, RecordingStarted, lambda: called.append(True))
        event_bus.publish(RecordingStarted(timestamp=1.0))
        assert len(called) == 1

    def test_config_from_kwargs(self) -> None:
        config = RecorderConfig.from_kwargs(
            model="base",
            language="en",
            use_microphone=False,
        )
        assert config.transcription.model == "base"
        assert config.transcription.language == "en"
        assert config.audio.use_microphone is False

    def test_validate_language_passes_for_multilingual_model(self) -> None:
        config = RecorderConfig.from_kwargs(model="large-v3", language="es")
        # Should not raise — large-v3 is multilingual and supports detection.
        _validate_language_against_model(config)

    def test_validate_language_passes_for_empty_language(self) -> None:
        # Empty language = auto-detect; never rejected.
        config = RecorderConfig.from_kwargs(model="tiny.en", language="")
        _validate_language_against_model(config)

    def test_validate_language_passes_for_matching_english_only(self) -> None:
        config = RecorderConfig.from_kwargs(model="tiny.en", language="en")
        _validate_language_against_model(config)

    def test_validate_language_rejects_unsupported_on_english_only(self) -> None:
        config = RecorderConfig.from_kwargs(model="tiny.en", language="es")
        with pytest.raises(ConfigurationError, match="does not support language"):
            _validate_language_against_model(config)

    def test_validate_language_rejects_unsupported_on_realtime_model(self) -> None:
        # Main model is multilingual, but the realtime model is English-only —
        # the realtime path would silently fail to transcribe Spanish.
        config = RecorderConfig.from_kwargs(
            model="large-v3",
            language="es",
            enable_realtime_transcription=True,
            use_main_model_for_realtime=False,
            realtime_model_type="tiny.en",
        )
        with pytest.raises(ConfigurationError, match="Realtime model"):
            _validate_language_against_model(config)

    def test_validate_language_unknown_model_passes(self) -> None:
        # Catalog is not exhaustive — onnx-asr accepts arbitrary HF repo paths.
        config = RecorderConfig.from_kwargs(model="org/some-unknown-model", language="ja")
        _validate_language_against_model(config)

    def test_diarization_toggle_callbacks_wired(self) -> None:
        """``wire_all_callbacks`` dispatches the 3 toggle events with the
        right argument shapes (started/completed → ``(enabled,)``;
        failed → ``(enabled, reason, category, detail)``)."""
        from src.recorder.bootstrap import wire_all_callbacks
        from src.recorder.domain.events import (
            DiarizationToggleCompleted,
            DiarizationToggleFailed,
            DiarizationToggleStarted,
        )

        event_bus = EventBus()
        started: list[bool] = []
        completed: list[bool] = []
        failed: list[tuple[bool, str, str, str]] = []
        callbacks: dict[str, object] = {
            "on_diarization_toggle_started": lambda enabled: started.append(enabled),
            "on_diarization_toggle_completed": lambda enabled: completed.append(enabled),
            "on_diarization_toggle_failed": lambda enabled, reason, category, detail: failed.append(
                (enabled, reason, category, detail)
            ),
        }
        wire_all_callbacks(event_bus, cast("CallbackMap", callbacks))

        event_bus.publish(DiarizationToggleStarted(timestamp=1.0, enabled=True))
        event_bus.publish(DiarizationToggleCompleted(timestamp=2.0, enabled=False))
        event_bus.publish(
            DiarizationToggleFailed(
                timestamp=3.0,
                enabled=True,
                reason="boom",
                category="network",
                detail="DNS",
            )
        )

        assert started == [True]
        assert completed == [False]
        assert failed == [(True, "boom", "network", "DNS")]

    def test_build_diarizer_constructs_with_config_args(self) -> None:
        """``build_diarizer`` passes every DiarizationConfig knob into
        OnnxAsrDiarizer so the runtime toggle worker constructs identically
        to cold boot."""
        from unittest.mock import patch

        from src.recorder.bootstrap import build_diarizer
        from src.recorder.domain.config import DiarizationConfig

        cfg = DiarizationConfig(
            enabled=True,
            max_speakers=5,
            delta_new=0.42,
            rho_update=0.7,
            segmentation_model="seg/model",
            embedding_model="emb/model",
        )
        captured: dict[str, object] = {}

        class _FakeDiarizer:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

        with patch(
            "src.recorder.infrastructure.onnxasr_diarizer.OnnxAsrDiarizer",
            _FakeDiarizer,
        ):
            result = build_diarizer(cfg)

        assert isinstance(result, _FakeDiarizer)
        assert captured == {
            "max_speakers": 5,
            "delta_new": 0.42,
            "rho_update": 0.7,
            "segmentation_model": "seg/model",
            "embedding_model": "emb/model",
        }


class TestResolveQuantization:
    """``_resolve_quantization`` enforces the param-count-gated auto-fp16-on-CUDA
    policy. Auto means fp32 everywhere except CUDA + large models, because
    fp16 is *slower* than fp32 below ~500M params (cast overhead at I/O
    boundaries dominates the small attention layers) and has no CPU EP
    acceleration at all."""

    def _resolve(
        self,
        requested: str,
        device: str,
        params: int,
        available: list[str] | None = None,
    ) -> str | None:
        from src.recorder.bootstrap import _resolve_quantization

        return _resolve_quantization(requested, device, params, available)

    def test_auto_cpu_returns_fp32_even_for_large_models(self) -> None:
        # CPU EP has no fp16 kernels — fp16 there just round-trips through fp32.
        assert self._resolve("auto", "cpu", 1_500_000_000) is None
        assert self._resolve("", "cpu", 1_500_000_000) is None  # empty string = auto

    def test_auto_cuda_picks_fp32_for_small_models(self) -> None:
        # tiny / base / small all fall below the 500M breakeven.
        for params in (39_000_000, 74_000_000, 244_000_000, 499_999_999):
            # The actual resolved device depends on local install — when CUDA is
            # available the threshold matters; when CUDA falls back to CPU we
            # also get fp32. Either way: small models on auto -> fp32.
            assert self._resolve("auto", "cuda", params) is None, f"unexpected fp16 at {params} params"

    def test_concrete_quant_passes_through(self) -> None:
        # Explicit user selection is honoured verbatim on CPU; the load-time
        # path in OnnxAsrTranscriber wraps fp16 with the patch+EXTENDED
        # workaround. Sub-fp16 quants (q4, bnb4, int8 ...) are valid on the
        # CPU EP and pass through there.
        assert self._resolve("fp16", "cpu", 39_000_000) == "fp16"
        assert self._resolve("q4", "cpu", 39_000_000) == "q4"
        assert self._resolve("bnb4", "cpu", 39_000_000) == "bnb4"
        # fp16 is the one concrete quant that is GPU-compatible
        # (_GPU_COMPATIBLE_QUANTIZATIONS = {"", "fp16"}), so it passes
        # through on CUDA too.
        assert self._resolve("fp16", "cuda", 39_000_000) == "fp16"

    def test_concrete_unsupported_quant_on_cuda_falls_back_to_fp32(self) -> None:
        # bnb4 (and every other sub-fp16 quant) is deliberately blocked on
        # CUDA: ORT's CUDAExecutionProvider can't fuse Q/DQ nodes and
        # per-channel int8 has a Whisper-encoder hallucination bug. The
        # documented fallback is fp32 (None) with a warning — honoring the
        # request would be actively harmful. bnb4 is broken upstream for
        # ONNX Whisper regardless; this must NOT be re-enabled.
        #
        # Hermetic: pin the resolved EP to CUDA so the assertion exercises the
        # GPU-incompatible-quant branch on every host. Without this, a box with
        # no CUDA runtime (this DirectML dev machine, CPU-only CI) resolves the
        # accelerator to DirectML/CPU — where sub-fp16 quants legitimately pass
        # through — and the test would flip purely on host hardware. Mirrors the
        # patch pattern in test_sense_voice_dml_override_routes_to_cpu.
        from unittest.mock import patch

        with (
            patch("src.recorder.infrastructure.device.resolve_accelerator", return_value="cuda"),
            patch("src.recorder.infrastructure.device.resolve_device", return_value="cuda"),
        ):
            assert self._resolve("bnb4", "cuda", 1_500_000_000) is None
            assert self._resolve("q4", "cuda", 1_500_000_000) is None
            assert self._resolve("int8", "cuda", 1_500_000_000) is None

    def test_unknown_model_with_no_param_count_stays_fp32_on_auto(self) -> None:
        # An off-catalog repo (param_count defaults to 0) must not trigger
        # auto-fp16 — we can't vouch for its size.
        assert self._resolve("auto", "cuda", 0) is None

    def test_auto_does_not_pick_fp16_when_model_lacks_fp16_export(self) -> None:
        # The canary regression: NeMo Canary is 978M (≥500M) but the
        # istupakov repo only publishes ``["", "int8"]``. Auto must NOT
        # resolve to fp16 — that asks onnx-asr for a ``*?fp16.onnx`` that
        # doesn't exist, which previously triggered a full fallback to tiny
        # on every startup. Deterministic regardless of local CUDA: the
        # availability gate short-circuits before the device check.
        assert self._resolve("auto", "cuda", 978_000_000, ["", "int8"]) is None
        assert self._resolve("", "cuda", 978_000_000, ["", "int8"]) is None

    def test_concrete_quant_not_published_falls_back_to_fp32(self) -> None:
        # Explicitly requesting a precision the model doesn't ship resolves
        # to fp32 instead of failing with ModelFileNotFoundError.
        assert self._resolve("fp16", "cpu", 978_000_000, ["", "int8"]) is None
        assert self._resolve("q4", "cpu", 39_000_000, [""]) is None

    def test_published_quant_still_honored(self) -> None:
        # When the model DOES publish the requested variant, behaviour is
        # unchanged (concrete pass-through on CPU; auto-fp16 gate still
        # subject to the existing device/param checks).
        assert self._resolve("fp16", "cpu", 39_000_000, ["", "fp16"]) == "fp16"
        assert self._resolve("int8", "cpu", 39_000_000, ["", "int8"]) == "int8"

    def test_available_none_stays_permissive_for_off_catalog_repos(self) -> None:
        # Off-catalog HF repos (available=None) keep the historical
        # assume-it-exists behaviour — we can't enumerate their variants.
        assert self._resolve("fp16", "cpu", 39_000_000, None) == "fp16"

    def test_sense_voice_auto_routes_to_int8_on_cpu(self) -> None:
        """SenseVoice ships int8-only (matches Handy's bundled flavour). With
        ``auto`` quantization on CPU the resolver must pick ``int8`` from the
        :data:`_INT8_PREFERRED_FAMILIES` set — fp32 would be a memory pessimi-
        zation against the published export, and fp16 isn't available.
        """
        from src.recorder.bootstrap import _resolve_quantization

        # CPU / non-CUDA path with int8 available + sense_voice family ⇒ int8.
        assert _resolve_quantization("auto", "cpu", 234_000_000, ["int8"], family="sense_voice") == "int8"
        # Explicit int8 also passes through.
        assert _resolve_quantization("int8", "cpu", 234_000_000, ["int8"], family="sense_voice") == "int8"

    def test_sense_voice_dml_override_routes_to_cpu(self) -> None:
        """SenseVoice is in :data:`_DML_INCOMPATIBLE_FAMILIES` — the Conformer
        encoder graph crashes on DirectML / ROCm / CoreML the same way NeMo /
        Cohere / GigaAM / Kaldi / T-One do. ``_override_dml_to_cpu_for_incompatible_family``
        must reroute providers to CPU EP only.

        We monkey-patch ``resolve_accelerator`` so the test is hermetic — the
        CI host doesn't have a DirectML EP registered, which would otherwise
        cause the helper's internal ``resolve_accelerator("directml")`` call
        to fall back to ``"cpu"`` and pass the providers through unchanged.
        """
        from unittest.mock import patch

        from src.recorder.bootstrap import _override_dml_to_cpu_for_incompatible_family

        original = ["DmlExecutionProvider", "CPUExecutionProvider"]
        with patch(
            "src.recorder.infrastructure.device.resolve_accelerator",
            return_value="directml",
        ):
            result = _override_dml_to_cpu_for_incompatible_family(
                original,
                family="sense_voice",
                accelerator="directml",
                device="cuda",
            )
        assert result == ["CPUExecutionProvider"]

    def test_sense_voice_is_in_dml_incompatible_set(self) -> None:
        """SenseVoice belongs in :data:`_DML_INCOMPATIBLE_FAMILIES` — the
        Conformer encoder graph crashes on DirectML / ROCm / CoreML the same
        way NeMo / Cohere / GigaAM / Kaldi / T-One do. Pure-data assert (no
        DML EP needed on the test host).
        """
        from src.recorder.domain.model_registry import _DML_INCOMPATIBLE_FAMILIES

        assert "sense_voice" in _DML_INCOMPATIBLE_FAMILIES

    def test_sense_voice_is_in_int8_preferred_set(self) -> None:
        """SenseVoice belongs in :data:`_INT8_PREFERRED_FAMILIES` so the
        ``auto`` quantization path picks the published int8 export instead
        of asking onnx-asr for a non-existent fp32 graph."""
        from src.recorder.bootstrap import _INT8_PREFERRED_FAMILIES

        assert "sense_voice" in _INT8_PREFERRED_FAMILIES

    def test_dolphin_is_in_dml_incompatible_set(self) -> None:
        """Dolphin's sherpa-onnx int8 CTC graph segfaults DirectML's
        MLOperatorAuthorImpl reshape kernel (empirically verified — exit 139),
        exactly like SenseVoice / NeMo. It must route to CPU on DML / ROCm /
        CoreML."""
        from src.recorder.domain.model_registry import _DML_INCOMPATIBLE_FAMILIES

        assert "dolphin" in _DML_INCOMPATIBLE_FAMILIES

    def test_int8_preferred_families_all_route_to_cpu_on_dml(self) -> None:
        """Invariant: every int8-preferred family ships an int8 graph that
        crashes non-CUDA GPU EPs, so the two sets must stay in lock-step —
        otherwise ``auto``→int8 picks a graph that then segfaults on DML."""
        from src.recorder.bootstrap import _INT8_PREFERRED_FAMILIES
        from src.recorder.domain.model_registry import _DML_INCOMPATIBLE_FAMILIES

        assert _INT8_PREFERRED_FAMILIES == _DML_INCOMPATIBLE_FAMILIES


class TestWakeWordBackendSelection:
    """Lock the registry invariant: each backend name routes to exactly ONE
    builder. The default 'composite' case is the only path that ever
    instantiates both Porcupine and openWakeWord; picking 'pvporcupine' or
    'openwakeword' must NOT pull in the other engine's heavyweight import
    (pvporcupine ~6 MB, openwakeword brings scipy + sklearn). This is the
    "wake-word backend pruning" RAM-lifecycle guarantee — without it both
    detectors stay co-resident even when the user only configured one.
    """

    def test_pvporcupine_alias_maps_to_porcupine_builder(self) -> None:
        from src.recorder.bootstrap import WAKE_WORD_BACKENDS, _build_porcupine_detector

        # Every Porcupine alias must route to the porcupine builder (one
        # function), never to ``_build_composite_detector`` which would
        # bring openwakeword into the import graph.
        for alias in ("pvp", "pvporcupine"):
            assert WAKE_WORD_BACKENDS[alias] is _build_porcupine_detector

    def test_openwakeword_aliases_map_to_oww_builder(self) -> None:
        from src.recorder.bootstrap import WAKE_WORD_BACKENDS, _build_oww_detector

        for alias in ("oww", "openwakeword", "openwakewords"):
            assert WAKE_WORD_BACKENDS[alias] is _build_oww_detector

    def test_composite_alias_maps_to_composite_builder(self) -> None:
        from src.recorder.bootstrap import WAKE_WORD_BACKENDS, _build_composite_detector

        # Only the explicit 'composite' key is allowed to build the
        # both-engines detector. No silent alias should leak both into
        # memory.
        assert WAKE_WORD_BACKENDS["composite"] is _build_composite_detector

    def test_porcupine_builder_does_not_import_openwakeword(self) -> None:
        """When the user selects 'pvporcupine', the builder must not
        construct an ``OWWDetector``. We monkeypatch both engine classes
        with sentinels and verify only the Porcupine sentinel was invoked.
        """
        from src.recorder.bootstrap import _build_porcupine_detector
        from src.recorder.domain.config import RecorderConfig
        from src.recorder.infrastructure import oww_detector as oww_module
        from src.recorder.infrastructure import porcupine_detector as porcupine_module

        config = RecorderConfig.from_kwargs(
            wakeword_backend="pvporcupine",
            wake_words="alexa",
            use_microphone=False,
        )

        porcupine_calls, oww_calls = _swap_engine_classes(porcupine_module, oww_module)
        try:
            _build_porcupine_detector(config)
        finally:
            _restore_engine_classes(porcupine_module, oww_module)

        assert len(porcupine_calls) == 1
        assert oww_calls == [], "porcupine backend must not construct OWWDetector"

    def test_oww_builder_does_not_import_porcupine(self) -> None:
        """Symmetric: selecting 'openwakeword' must not construct a
        Porcupine detector. Holding both engines costs ~15-30 MB of
        session RAM for no benefit when only one backend is in use.
        """
        from src.recorder.bootstrap import _build_oww_detector
        from src.recorder.domain.config import RecorderConfig
        from src.recorder.infrastructure import oww_detector as oww_module
        from src.recorder.infrastructure import porcupine_detector as porcupine_module

        config = RecorderConfig.from_kwargs(
            wakeword_backend="openwakeword",
            openwakeword_model_paths="alexa",
            use_microphone=False,
        )

        porcupine_calls, oww_calls = _swap_engine_classes(porcupine_module, oww_module)
        try:
            _build_oww_detector(config)
        finally:
            _restore_engine_classes(porcupine_module, oww_module)

        assert len(oww_calls) == 1
        assert porcupine_calls == [], "oww backend must not construct PorcupineDetector"


# Module-level scratch storage for the wake-word sentinel swap helpers.
_ORIGINAL_ENGINE_CLASSES: dict[str, object] = {}


def _swap_engine_classes(
    porcupine_module: Any,  # noqa: ANN401 — duck-typed live module reference
    oww_module: Any,  # noqa: ANN401 — duck-typed live module reference
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Replace the engine constructors with sentinels, return their call logs."""
    porcupine_calls: list[dict[str, object]] = []
    oww_calls: list[dict[str, object]] = []

    class _PorcupineSentinel:
        def __init__(self, **kwargs: object) -> None:
            porcupine_calls.append(kwargs)

    class _OwwSentinel:
        def __init__(self, **kwargs: object) -> None:
            oww_calls.append(kwargs)

    _ORIGINAL_ENGINE_CLASSES["porcupine"] = porcupine_module.PorcupineDetector
    _ORIGINAL_ENGINE_CLASSES["oww"] = oww_module.OWWDetector
    porcupine_module.PorcupineDetector = _PorcupineSentinel
    oww_module.OWWDetector = _OwwSentinel
    return porcupine_calls, oww_calls


def _restore_engine_classes(porcupine_module: Any, oww_module: Any) -> None:  # noqa: ANN401
    porcupine_module.PorcupineDetector = _ORIGINAL_ENGINE_CLASSES["porcupine"]
    oww_module.OWWDetector = _ORIGINAL_ENGINE_CLASSES["oww"]
