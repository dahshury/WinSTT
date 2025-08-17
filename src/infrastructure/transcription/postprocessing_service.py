"""Token decoding and simple segmentation for Whisper outputs."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

import numpy as np

from src.domain.transcription.entities.transcription_segment import TranscriptionSegment

if TYPE_CHECKING:
    from transformers import WhisperTokenizerFast


class WhisperPostprocessingService:
    """Converts token IDs/logits to text and segments."""

    def __init__(self, tokenizer: WhisperTokenizerFast):
        self._tokenizer = tokenizer

    def decode_tokens(self, output_ids: np.ndarray) -> str:
        if output_ids.ndim == 3:
            token_ids = np.argmax(output_ids, axis=-1)
        elif output_ids.ndim == 2:
            token_ids = output_ids.astype(np.int64, copy=False)
        elif output_ids.ndim == 1:
            token_ids = output_ids[None, :].astype(np.int64, copy=False)
        else:
            return ""
        ids_seq = token_ids[0].tolist() if hasattr(token_ids, "tolist") else list(token_ids[0])
        if not ids_seq:
            return ""
        transcription = self._tokenizer.decode(ids_seq, skip_special_tokens=True)
        return (transcription or "").strip()

    def simple_segments(self, audio_duration: float, transcription: str) -> list[TranscriptionSegment]:
        if not transcription:
            return [TranscriptionSegment.create_simple_segment(0.0, max(0.5, audio_duration), transcription)]
        sentences = re.split(r"(?<=[.!?])\s+", transcription)
        sentences = [s.strip() for s in sentences if s.strip()]
        if not sentences:
            return [TranscriptionSegment.create_simple_segment(0.0, max(0.5, audio_duration), transcription)]
        duration_per_segment = (audio_duration or 30.0) / max(1, len(sentences))
        segments: list[TranscriptionSegment] = []
        for i, sentence in enumerate(sentences):
            start_time = i * duration_per_segment
            end_time = (i + 1) * duration_per_segment
            segments.append(TranscriptionSegment.create_simple_segment(start_time, end_time, sentence, i))
        return segments


