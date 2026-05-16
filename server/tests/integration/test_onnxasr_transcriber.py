from __future__ import annotations

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
    """
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

    def test_shutdown_closes_both_model_and_vad(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """shutdown() must release the ASR model AND the always-loaded VAD."""
        from src.recorder.infrastructure.onnxasr_transcriber import OnnxAsrTranscriber

        fake_model, fake_vad, _fake_adapter = _install_fake_onnx_asr(monkeypatch)

        transcriber = OnnxAsrTranscriber(model_name="whisper-base")
        transcriber.shutdown()

        fake_model.close.assert_called_once()
        fake_vad.close.assert_called_once()
        assert not transcriber.is_ready()

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
