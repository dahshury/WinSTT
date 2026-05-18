from __future__ import annotations

from pydantic import BaseModel, Field


class SynthesizerConfig(BaseModel):
    """Pydantic config for the TTS subsystem.

    The runtime download flow places assets under ``cache_dir`` (defaults to
    ``%LOCALAPPDATA%/winstt/tts/kokoro`` on Windows). ``model_path`` and
    ``voices_path`` resolve relative to ``cache_dir`` when not absolute.
    """

    model_config = {"frozen": False, "strict": True}

    enabled: bool = False
    cache_dir: str | None = None
    # Default to the fp16 Kokoro-82M ONNX — 163 MB, quality close to fp32
    # without the size penalty. See research report for variant trade-offs.
    model_filename: str = "kokoro-v1.0.fp16.onnx"
    voices_filename: str = "voices-v1.0.bin"
    voice: str = "af_heart"
    lang: str = "en-us"
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    # "auto" reuses the resolution from ``recorder.infrastructure.device``;
    # "cuda" / "cpu" pin explicitly. Falls back to CPU if CUDA EP can't load.
    device: str = "auto"
