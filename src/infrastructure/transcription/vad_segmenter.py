"""Silero VAD-based offline segmenter (infrastructure layer).

Implements robust speech segmentation using the Silero VAD ONNX model
with streaming state, adapted from onnx-asr's segmentation approach.

Produces start/end sample indices at 16 kHz suitable for batching
ASR over long durations with accurate timestamps.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import chain
from typing import TYPE_CHECKING

import numpy as np
import onnxruntime as ort

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator


@dataclass
class VadSegmentationConfig:
    """Configuration for VAD segmentation thresholds and limits."""

    sample_rate: int = 16_000
    threshold: float = 0.5
    neg_threshold: float | None = None
    min_speech_duration_ms: float = 250.0
    max_speech_duration_s: float = 20.0
    min_silence_duration_ms: float = 100.0
    speech_pad_ms: float = 30.0


class SileroVadSegmenter:
    """Segmenter that runs Silero VAD in a streaming manner to produce segments.

    Expects the Silero model with `input`, `state`, and `sr` inputs and
    `output`, `stateN` outputs (as used by widely available Silero ONNX exports).
    """

    CONTEXT_SIZE = 64
    HOP_SIZE = 512
    DEFAULT_SR = 16_000

    def __init__(self, model_path: str, providers: list[str] | None = None):
        # Create optimized session options like onnx_asr
        sess_options = ort.SessionOptions()
        sess_options.enable_cpu_mem_arena = True
        sess_options.enable_mem_pattern = True
        sess_options.enable_mem_reuse = True
        sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        
        self._session = ort.InferenceSession(
            model_path,
            sess_options=sess_options,
            providers=providers or ort.get_available_providers(),
        )

    def _encode(self, waveforms: np.ndarray) -> Iterator[np.ndarray]:
        """Run the VAD over sliding windows, maintaining state; yield per-step probs.

        waveforms: shape (B, T) float32 mono
        yields: np.ndarray of shape (B,) per hop with speech probabilities
        """
        frames = np.lib.stride_tricks.sliding_window_view(
            waveforms, self.CONTEXT_SIZE + self.HOP_SIZE, axis=-1,
        )[:, self.HOP_SIZE - self.CONTEXT_SIZE :: self.HOP_SIZE]

        state = np.zeros((2, frames.shape[0], 128), dtype=np.float32)

        def process(frame: np.ndarray) -> np.ndarray:
            nonlocal state
            output, new_state = self._session.run(
                ["output", "stateN"],
                {"input": frame, "state": state, "sr": [self.DEFAULT_SR]},
            )
            # Use assertions for type checking like onnx_asr for better performance
            assert isinstance(output, np.ndarray)
            assert output.dtype == np.float32
            assert isinstance(new_state, np.ndarray)
            assert new_state.dtype == np.float32
            state = new_state
            return output[:, 0]

        # Process first frame with left padding
        yield process(np.pad(waveforms[:, : self.HOP_SIZE], ((0, 0), (self.CONTEXT_SIZE, 0))))

        # Process all full frames
        for i in range(frames.shape[1]):
            yield process(frames[:, i])

        # Process last frame with right padding if needed (optimized condition like onnx_asr)
        if last_frame := waveforms.shape[1] % self.HOP_SIZE:
            yield process(
                np.pad(
                    waveforms[:, -last_frame - self.CONTEXT_SIZE :],
                    ((0, 0), (0, self.HOP_SIZE - last_frame)),
                ),
            )

    @staticmethod
    def _find_segments(
        probs: Iterable[np.float32],
        *,
        hop_size: int,
        threshold: float,
        neg_threshold: float | None,
    ) -> Iterator[tuple[int, int]]:
        if neg_threshold is None:
            neg_threshold = threshold - 0.15

        state = 0
        start = 0
        for i, p in enumerate(chain(probs, (np.float32(0),))):
            if state == 0 and p >= threshold:
                state = 1
                start = i * hop_size
            elif state == 1 and p < neg_threshold:
                state = 0
                yield start, i * hop_size

    @staticmethod
    def _merge_segments(
        segments: Iterator[tuple[int, int]],
        waveform_len: int,
        *,
        sample_rate: int,
        min_speech_duration_ms: float,
        max_speech_duration_s: float,
        min_silence_duration_ms: float,
        speech_pad_ms: float,
    ) -> Iterator[tuple[int, int]]:
        speech_pad = int(speech_pad_ms * sample_rate // 1000)
        min_speech_duration = int(min_speech_duration_ms * sample_rate // 1000) - 2 * speech_pad
        max_speech_duration = int(max_speech_duration_s * sample_rate) - 2 * speech_pad
        min_silence_duration = int(min_silence_duration_ms * sample_rate // 1000) + 2 * speech_pad

        # Use constants like onnx_asr for better performance
        inf = 10**15
        cur_start, cur_end = -inf, -inf
        for start, end in chain(
            segments,
            ((waveform_len, waveform_len), (inf, inf)),
        ):
            if start - cur_end < min_silence_duration and end - cur_start < max_speech_duration:
                cur_end = end
            else:
                if cur_end - cur_start > min_speech_duration:
                    yield max(cur_start - speech_pad, 0), min(cur_end + speech_pad, waveform_len)
                # use local variable to avoid reassigning loop variable
                span_start = start
                while end - span_start > max_speech_duration:
                    yield max(span_start - speech_pad, 0), span_start + max_speech_duration - speech_pad
                    span_start += max_speech_duration
                cur_start, cur_end = start, end

    def segment(self, waveform: np.ndarray, config: VadSegmentationConfig | None = None) -> list[tuple[int, int]]:
        """Segment a mono waveform at 16 kHz into speech regions.

        Returns a list of (start_sample, end_sample) pairs.
        """
        if waveform.ndim != 1:
            msg = "Expected mono waveform (1D)"
            raise ValueError(msg)
        if waveform.dtype != np.float32:
            waveform = waveform.astype(np.float32, copy=False)

        cfg = config or VadSegmentationConfig()
        if cfg.sample_rate != self.DEFAULT_SR:
            msg = "SileroVadSegmenter expects 16 kHz input"
            raise ValueError(msg)

        batch = waveform[None, :]
        # Collect probabilities per hop
        probs_iter = (probs[0] for probs in self._encode(batch))
        segs_iter = self._find_segments(
            probs_iter,
            hop_size=self.HOP_SIZE,
            threshold=cfg.threshold,
            neg_threshold=cfg.neg_threshold,
        )
        merged = self._merge_segments(
            segs_iter,
            waveform_len=waveform.shape[0],
            sample_rate=cfg.sample_rate,
            min_speech_duration_ms=cfg.min_speech_duration_ms,
            max_speech_duration_s=cfg.max_speech_duration_s,
            min_silence_duration_ms=cfg.min_silence_duration_ms,
            speech_pad_ms=cfg.speech_pad_ms,
        )
        return list(merged)


