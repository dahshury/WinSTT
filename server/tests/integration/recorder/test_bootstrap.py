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

    def _resolve(self, requested: str, device: str, params: int) -> str | None:
        from src.recorder.bootstrap import _resolve_quantization

        return _resolve_quantization(requested, device, params)

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
        # Explicit user selection is honoured verbatim; the load-time path in
        # OnnxAsrTranscriber wraps fp16 with the patch+EXTENDED workaround.
        assert self._resolve("fp16", "cpu", 39_000_000) == "fp16"
        assert self._resolve("q4", "cpu", 39_000_000) == "q4"
        assert self._resolve("bnb4", "cuda", 1_500_000_000) == "bnb4"

    def test_unknown_model_with_no_param_count_stays_fp32_on_auto(self) -> None:
        # An off-catalog repo (param_count defaults to 0) must not trigger
        # auto-fp16 — we can't vouch for its size.
        assert self._resolve("auto", "cuda", 0) is None
