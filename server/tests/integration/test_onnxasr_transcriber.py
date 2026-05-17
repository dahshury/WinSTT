from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import numpy as np
import pytest

try:
    import onnx_asr  # noqa: F401

    HAS_ONNX_ASR = True
except ImportError:
    HAS_ONNX_ASR = False

from src.recorder.domain.ports.transcriber import ITranscriber

_TRANSCRIBER_MODULE = "src.recorder.infrastructure.onnxasr_transcriber"


class _FakeSegment:
    """Minimal SegmentResult stand-in — duck-typed on ``.start`` / ``.end`` / ``.text``.

    The onnx-asr VAD adapter yields segments with *global* (whole-file)
    second offsets; the transcriber reads all three fields.
    """

    def __init__(self, text: str, start: float = 0.0, end: float = 0.0) -> None:
        self.start = start
        self.end = end
        self.text = text


def _install_fake_onnx_asr(
    monkeypatch: pytest.MonkeyPatch,
    *,
    segments: list[_FakeSegment] | None = None,
) -> tuple[MagicMock, MagicMock, MagicMock]:
    """Replace ``onnx_asr.load_model`` / ``load_vad`` with mocks for the transcriber module.

    Returns (fake_model, fake_vad, fake_adapter) so individual tests can
    assert how ``with_vad`` / ``recognize`` were called.

    Clears the process-shared VAD cache so each test sees its own
    ``fake_vad`` rather than a leftover instance from a sibling test.
    """
    # Lazy import — module-level import would race the skipif decorator
    # in environments where onnx_asr isn't installed.
    from src.recorder.infrastructure.onnxasr_transcriber import _close_cached_vads

    _close_cached_vads()

    fake_model = MagicMock(name="fake_model")
    fake_vad = MagicMock(name="fake_vad")
    fake_adapter = MagicMock(name="fake_adapter")
    fake_model.with_vad.return_value = fake_adapter
    fake_adapter.recognize.return_value = iter(segments or [_FakeSegment("hello world")])

    # Dotted-string monkeypatch — avoids mypy attr-defined on the module's
    # conditionally-imported ``onnx_asr`` symbol (set to ``None`` if the
    # import fails at module load).
    monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", lambda *_a, **_kw: fake_model)
    monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_vad", lambda *_a, **_kw: fake_vad)
    # Bypass provider introspection — the mocks don't expose ORT sessions.
    monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}._snapshot_providers", lambda _m: ["CPUExecutionProvider"])

    return fake_model, fake_vad, fake_adapter


@pytest.mark.skipif(not HAS_ONNX_ASR, reason="onnx-asr not installed")
class TestOnnxAsrTranscriber:
    def test_implements_interface(self) -> None:
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        assert issubclass(OnnxAsrTranscriber, ITranscriber)

    def test_constructor_requires_onnx_asr(self) -> None:
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        # Verify the class can be imported and has the expected signature
        assert hasattr(OnnxAsrTranscriber, "transcribe")
        assert hasattr(OnnxAsrTranscriber, "is_ready")
        assert hasattr(OnnxAsrTranscriber, "shutdown")

    def test_init_eagerly_loads_silero_vad(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Silero VAD must be loaded inside __init__ — no lazy first-call init."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        _fake_model, fake_vad, _fake_adapter = _install_fake_onnx_asr(monkeypatch)

        transcriber = OnnxAsrTranscriber(model_name="whisper-base", quantization="int8")

        # Both ASR and VAD attached immediately, before any transcribe() call.
        assert transcriber._vad is fake_vad
        assert transcriber.is_ready()

    def test_transcribe_routes_through_with_vad_and_joins_segments(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """transcribe() must call model.with_vad(vad, max_speech_duration_s=29) and join segment texts."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        fake_model, fake_vad, fake_adapter = _install_fake_onnx_asr(
            monkeypatch,
            segments=[_FakeSegment("hello"), _FakeSegment(" world "), _FakeSegment("again")],
        )

        transcriber = OnnxAsrTranscriber(model_name="whisper-base", quantization="int8")
        audio = np.zeros(16_000, dtype=np.float32)

        result = transcriber.transcribe(audio, language="en")

        fake_model.with_vad.assert_called_once()
        call_args, call_kwargs = fake_model.with_vad.call_args
        assert call_args[0] is fake_vad
        assert call_kwargs.get("max_speech_duration_s") == pytest.approx(29.0)
        # Chunk-merge param: short silences are bridged so VAD emits ~29 s
        # chunks instead of one tiny segment per micro-pause.
        assert call_kwargs.get("min_silence_duration_ms") == pytest.approx(2000.0)

        fake_adapter.recognize.assert_called_once()
        rec_args, rec_kwargs = fake_adapter.recognize.call_args
        assert rec_args[0] is audio
        assert rec_kwargs.get("sample_rate") == 16_000
        assert rec_kwargs.get("language") == "en"

        # Texts are stripped and space-joined — empty/whitespace segments are dropped.
        assert result.text == "hello world again"

    def test_transcribe_omits_language_when_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """An empty language string must not be forwarded as ``language=""`` to onnx-asr."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        _fake_model, _fake_vad, fake_adapter = _install_fake_onnx_asr(monkeypatch)
        transcriber = OnnxAsrTranscriber(model_name="whisper-base")
        audio = np.zeros(16_000, dtype=np.float32)

        transcriber.transcribe(audio, language="")

        fake_adapter.recognize.assert_called_once()
        _rec_args, rec_kwargs = fake_adapter.recognize.call_args
        assert "language" not in rec_kwargs

    def test_transcribe_drops_language_on_typeerror_retry(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Backends that don't accept the language kwarg should still transcribe via the retry path."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        fake_model, _fake_vad, fake_adapter = _install_fake_onnx_asr(monkeypatch)
        # First call raises TypeError (simulating a model that rejects language kwarg);
        # second call (without language) succeeds.
        recognize_calls: list[dict[str, Any]] = []

        def fake_recognize(*_args: object, **kwargs: object) -> Any:  # noqa: ANN401
            recognize_calls.append(kwargs)
            if "language" in kwargs:
                raise TypeError("model does not accept language kwarg")
            return iter([_FakeSegment("ok")])

        fake_adapter.recognize.side_effect = fake_recognize

        transcriber = OnnxAsrTranscriber(model_name="whisper-base")
        audio = np.zeros(16_000, dtype=np.float32)

        result = transcriber.transcribe(audio, language="en")

        assert result.text == "ok"
        # First call had language, second didn't.
        assert len(recognize_calls) == 2
        assert "language" in recognize_calls[0]
        assert "language" not in recognize_calls[1]
        # with_vad called once and the adapter is reused for the retry.
        fake_model.with_vad.assert_called_once()

    def test_shutdown_releases_model_but_keeps_cached_vad(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """shutdown() drops the ASR model but does NOT close the VAD.

        The VAD is process-shared via ``_VAD_CACHE`` — closing it on every
        swap would force the next swap to pay the 100-400ms load cost
        again, which is exactly the regression the cache exists to
        prevent. The OS reclaims the VAD at process exit.
        """
        from src.recorder.infrastructure.onnxasr_transcriber import (
            OnnxAsrTranscriber,
            _close_cached_vads,
        )

        fake_model, fake_vad, _fake_adapter = _install_fake_onnx_asr(monkeypatch)

        transcriber = OnnxAsrTranscriber(model_name="whisper-base")
        transcriber.shutdown()

        fake_model.close.assert_called_once()
        fake_vad.close.assert_not_called()
        assert not transcriber.is_ready()
        _close_cached_vads()

    def test_transcribe_segments_returns_global_offset_tuples(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """transcribe_segments() returns (start, end, text) tuples from the same VAD pipeline.

        This is the codepath the file-transcription SRT export uses — it must
        share with_vad() with transcribe() and preserve the global second
        offsets the onnx-asr VAD adapter assigns to each speech run.
        """
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        fake_model, fake_vad, fake_adapter = _install_fake_onnx_asr(
            monkeypatch,
            segments=[
                _FakeSegment("first cue", start=0.5, end=4.2),
                _FakeSegment("second cue", start=31.0, end=35.8),
            ],
        )

        transcriber = OnnxAsrTranscriber(model_name="whisper-base")
        audio = np.zeros(16_000, dtype=np.float32)

        segments = transcriber.transcribe_segments(audio, language="en")

        # SRT path: same VAD adapter but NO merge — cues must stay short
        # and readable, so min_silence_duration_ms is deliberately omitted
        # (only the 30 s-wall safety cap is applied).
        fake_model.with_vad.assert_called_once()
        _call_args, call_kwargs = fake_model.with_vad.call_args
        assert call_kwargs.get("max_speech_duration_s") == pytest.approx(29.0)
        assert "min_silence_duration_ms" not in call_kwargs
        _rec_args, rec_kwargs = fake_adapter.recognize.call_args
        assert rec_kwargs.get("language") == "en"

        # Global offsets preserved verbatim — the second cue is past 30 s,
        # proving long files aren't truncated.
        assert segments == [
            (0.5, 4.2, "first cue"),
            (31.0, 35.8, "second cue"),
        ]
        assert fake_vad is transcriber._vad

    def test_segment_with_vad_false_skips_silero_load(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Bounded-short callers (realtime) must NOT load Silero VAD."""
        from src.recorder.infrastructure import onnxasr_transcriber as mod
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        _fake_model, fake_vad, _fake_adapter = _install_fake_onnx_asr(monkeypatch)
        load_vad_calls: list[object] = []

        def _tracked_load_vad(*a: object, **kw: object) -> object:
            load_vad_calls.append((a, kw))
            return fake_vad

        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_vad", _tracked_load_vad)

        transcriber = OnnxAsrTranscriber(model_name="whisper-tiny", segment_with_vad=False)

        assert load_vad_calls == []  # Silero never loaded
        assert transcriber._vad is None
        assert transcriber._segment_with_vad is False
        assert isinstance(mod.OnnxAsrTranscriber, type)  # module import sanity

    def test_segment_with_vad_false_uses_direct_recognize(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """With VAD off, transcribe() calls model.recognize() directly — no with_vad, no trimming."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        fake_model, _fake_vad, _fake_adapter = _install_fake_onnx_asr(monkeypatch)
        fake_model.recognize.return_value = "  the full window verbatim  "

        transcriber = OnnxAsrTranscriber(model_name="whisper-tiny", segment_with_vad=False)
        audio = np.zeros(16_000, dtype=np.float32)

        result = transcriber.transcribe(audio, language="en")

        # Direct path: model.recognize() called, with_vad() NEVER called.
        fake_model.with_vad.assert_not_called()
        fake_model.recognize.assert_called_once()
        rec_args, rec_kwargs = fake_model.recognize.call_args
        assert rec_args[0] is audio
        assert rec_kwargs.get("sample_rate") == 16_000
        assert rec_kwargs.get("language") == "en"
        # Verbatim text returned (stripped by the join in transcribe()).
        assert result.text == "the full window verbatim"

    def test_segment_with_vad_false_shutdown_no_vad_close(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """shutdown() with VAD off closes the model only — there is no VAD to release."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        fake_model, fake_vad, _fake_adapter = _install_fake_onnx_asr(monkeypatch)

        transcriber = OnnxAsrTranscriber(model_name="whisper-tiny", segment_with_vad=False)
        transcriber.shutdown()

        fake_model.close.assert_called_once()
        fake_vad.close.assert_not_called()
        assert not transcriber.is_ready()

    def test_build_realtime_transcriber_disables_vad(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """bootstrap.build_realtime_transcriber must construct with segment_with_vad=False."""
        import src.recorder.bootstrap as bootstrap
        from src.recorder.domain.config import RecorderConfig

        captured: dict[str, object] = {}

        class _StubTranscriber:
            def __init__(self, **kwargs: object) -> None:
                captured.update(kwargs)

        monkeypatch.setattr(
            f"{_TRANSCRIBER_MODULE}.OnnxAsrTranscriber",
            _StubTranscriber,
        )

        cfg = RecorderConfig()
        cfg.realtime.realtime_model_type = "tiny"
        bootstrap.build_realtime_transcriber(cfg)

        assert captured.get("segment_with_vad") is False

    def test_fp16_sets_extended_optimization_level(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """quantization='fp16' must hand onnx_asr a SessionOptions with
        ORT_ENABLE_EXTENDED — the default ORT_ENABLE_ALL crashes the fp16
        encoder export via the SimplifiedLayerNormFusion bug."""
        import onnxruntime as rt

        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        _install_fake_onnx_asr(monkeypatch)
        captured: dict[str, Any] = {}

        def fake_load_model(*_a: object, **kw: object) -> object:
            captured.update(kw)
            return MagicMock()

        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", fake_load_model)

        OnnxAsrTranscriber(model_name="onnx-community/whisper-tiny.en", quantization="fp16")

        sess_options = captured.get("sess_options")
        assert isinstance(sess_options, rt.SessionOptions)
        assert sess_options.graph_optimization_level == rt.GraphOptimizationLevel.ORT_ENABLE_EXTENDED

    def test_non_fp16_does_not_pass_sess_options(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Non-fp16 paths (fp32 / q4 / bnb4 / unknown) don't need the
        SimplifiedLayerNormFusion workaround — sess_options stays absent."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        _install_fake_onnx_asr(monkeypatch)
        captured: dict[str, Any] = {}

        def fake_load_model(*_a: object, **kw: object) -> object:
            captured.update(kw)
            return MagicMock()

        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", fake_load_model)

        OnnxAsrTranscriber(model_name="onnx-community/whisper-tiny", quantization=None)
        assert "sess_options" not in captured

    def test_fp16_decoder_patch_retry_on_subgraph_error(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        """First load_model raises the malformed-subgraph error → we lift
        the path out of the message, run the in-cache patch, then a
        second load_model succeeds. The single-shot retry is the core
        of the fp16-Whisper workaround for the .en variants."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        _install_fake_onnx_asr(monkeypatch)

        decoder_path = tmp_path / "decoder_model_merged_fp16.onnx"
        decoder_path.write_bytes(b"\x00")

        first_err = RuntimeError(
            f"[ONNXRuntimeError] : 1 : FAIL : Load model from {decoder_path} failed: "
            "graph.cc:1491 InitializeStateFromModelFileGraphProto This is an invalid model. "
            "Subgraph output (logits) is an outer scope value being returned directly."
        )
        call_count = {"n": 0}
        succeeded_model = MagicMock(name="post_patch_model")

        def flaky_load_model(*_a: object, **_kw: object) -> object:
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise first_err
            return succeeded_model

        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", flaky_load_model)
        patched_paths: list[Path] = []

        def fake_patch(p: Path) -> int:
            patched_paths.append(p)
            return 34

        monkeypatch.setattr("src.recorder.infrastructure.onnx_patch.patch_whisper_decoder", fake_patch)
        monkeypatch.setattr("src.recorder.infrastructure.onnx_patch.should_skip_patch", lambda _p: False)

        transcriber = OnnxAsrTranscriber(
            model_name="onnx-community/whisper-tiny.en",
            quantization="fp16",
        )

        assert call_count["n"] == 2  # one failure + one successful retry
        assert patched_paths == [decoder_path]
        assert transcriber._model is succeeded_model

    def test_fp16_unrelated_subgraph_error_does_not_retry(
        self,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        """A "subgraph output is an outer scope value" error against any
        file that ISN'T a Whisper merged decoder must propagate as-is —
        we won't try to patch unrelated files."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        _install_fake_onnx_asr(monkeypatch)

        other_path = tmp_path / "encoder_model.onnx"
        other_path.write_bytes(b"\x00")
        err = RuntimeError(f"Load model from {other_path} failed: Subgraph output (foo) is an outer scope value")

        def always_fail(*_a: object, **_kw: object) -> object:
            raise err

        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", always_fail)

        with pytest.raises(RuntimeError):
            OnnxAsrTranscriber(model_name="onnx-community/whisper-tiny", quantization="fp16")


@pytest.mark.skipif(not HAS_ONNX_ASR, reason="onnx-asr not installed")
class TestSharedVadCache:
    """The Silero VAD is process-shared: first construction loads it,
    subsequent constructions with the same providers reuse it. This
    saves the 100-400ms ``onnx_asr.load_vad`` cost on every main-model
    swap after the first — the dominant cost after the model load
    itself."""

    def test_second_transcriber_reuses_cached_vad(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from src.recorder.infrastructure.onnxasr_transcriber import (
            OnnxAsrTranscriber,
            _close_cached_vads,
        )

        _close_cached_vads()
        load_vad_calls = 0
        fake_vad = MagicMock(name="shared_vad")

        def counting_load_vad(*_a: Any, **_kw: Any) -> Any:  # noqa: ANN401 — monkeypatched onnx_asr loader
            nonlocal load_vad_calls
            load_vad_calls += 1
            return fake_vad

        fake_model = MagicMock(name="fake_model")
        fake_model.with_vad.return_value = MagicMock()
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", lambda *_a, **_kw: fake_model)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_vad", counting_load_vad)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}._snapshot_providers", lambda _m: ["CPUExecutionProvider"])

        first = OnnxAsrTranscriber(model_name="whisper-base")
        second = OnnxAsrTranscriber(model_name="whisper-large")

        assert load_vad_calls == 1
        assert first._vad is fake_vad
        assert second._vad is fake_vad
        _close_cached_vads()

    def test_different_providers_get_independent_cache_entries(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from src.recorder.infrastructure.onnxasr_transcriber import (
            OnnxAsrTranscriber,
            _close_cached_vads,
        )

        _close_cached_vads()
        load_vad_calls: list[Any] = []
        fake_vads = [MagicMock(name="cpu_vad"), MagicMock(name="gpu_vad")]

        def varied_load_vad(*_a: Any, providers: Any = None, **_kw: Any) -> Any:  # noqa: ANN401 — monkeypatched onnx_asr loader
            load_vad_calls.append(providers)
            return fake_vads[len(load_vad_calls) - 1]

        fake_model = MagicMock(name="fake_model")
        fake_model.with_vad.return_value = MagicMock()
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", lambda *_a, **_kw: fake_model)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_vad", varied_load_vad)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}._snapshot_providers", lambda _m: ["CPUExecutionProvider"])

        first = OnnxAsrTranscriber(model_name="whisper-base", providers=["CPUExecutionProvider"])
        second = OnnxAsrTranscriber(model_name="whisper-base", providers=["CUDAExecutionProvider"])

        assert len(load_vad_calls) == 2
        assert first._vad is fake_vads[0]
        assert second._vad is fake_vads[1]
        _close_cached_vads()

    def test_close_cached_vads_releases_all_entries(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from src.recorder.infrastructure.onnxasr_transcriber import (
            _VAD_CACHE,
            OnnxAsrTranscriber,
            _close_cached_vads,
        )

        _close_cached_vads()
        fake_vad = MagicMock(name="cached_vad")
        fake_model = MagicMock(name="fake_model")
        fake_model.with_vad.return_value = MagicMock()
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", lambda *_a, **_kw: fake_model)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_vad", lambda *_a, **_kw: fake_vad)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}._snapshot_providers", lambda _m: ["CPUExecutionProvider"])

        OnnxAsrTranscriber(model_name="whisper-base")
        assert len(_VAD_CACHE) == 1

        _close_cached_vads()
        fake_vad.close.assert_called_once()
        assert len(_VAD_CACHE) == 0

    def test_close_cached_vads_swallows_close_exception(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A misbehaving VAD's ``close()`` must not block subsequent cache cleanup."""
        from src.recorder.infrastructure.onnxasr_transcriber import (
            _VAD_CACHE,
            OnnxAsrTranscriber,
            _close_cached_vads,
        )

        _close_cached_vads()
        fake_vad = MagicMock(name="bad_vad")
        fake_vad.close.side_effect = RuntimeError("boom")
        fake_model = MagicMock(name="fake_model")
        fake_model.with_vad.return_value = MagicMock()
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_model", lambda *_a, **_kw: fake_model)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}.onnx_asr.load_vad", lambda *_a, **_kw: fake_vad)
        monkeypatch.setattr(f"{_TRANSCRIBER_MODULE}._snapshot_providers", lambda _m: ["CPUExecutionProvider"])

        OnnxAsrTranscriber(model_name="whisper-base")
        _close_cached_vads()
        assert len(_VAD_CACHE) == 0
