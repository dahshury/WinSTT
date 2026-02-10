from __future__ import annotations

import pytest

try:
    import onnx_asr  # noqa: F401

    HAS_ONNX_ASR = True
except ImportError:
    HAS_ONNX_ASR = False

from src.recorder.domain.ports.transcriber import ITranscriber


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
