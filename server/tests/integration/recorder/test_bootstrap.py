from __future__ import annotations

import pytest

from src.building_blocks.errors import ConfigurationError
from src.building_blocks.event_bus import EventBus
from src.recorder.bootstrap import CALLBACK_EVENT_MAP, _validate_language_against_model, wire_callback
from src.recorder.domain.config import RecorderConfig
from src.recorder.domain.events import RecordingStarted


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
