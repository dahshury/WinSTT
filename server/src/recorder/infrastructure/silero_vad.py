"""Silero VAD adapter backed by ``onnx-asr`` (no torch dependency).

The ONNX Silero v5 model expects a fixed-size window of
``context_size + hop_size`` samples per inference (576 at 16 kHz, 288 at
8 kHz) plus a 2 x 1 x 128 LSTM state carried between calls. Each window is
the previous hop's last ``context_size`` samples followed by the next
``hop_size`` fresh samples; the very first window pads the context with
zeros. This adapter buffers incoming :class:`AudioChunk` frames into that
layout and feeds them to the ORT session.

Replaces the prior torch.hub-based loader. Loads the silero model via
``onnx_asr.load_vad("silero")`` which downloads from ``istupakov/silero-vad-onnx``
on first use and caches in the HF cache.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np
from numpy.typing import NDArray
from typing_extensions import override

from src.building_blocks.types import AudioChunk
from src.recorder.domain.ports.vad import IVoiceActivityDetector, VADResult

# Pulled in so :func:`providers_for_device` is resolvable at module level
# (used in the docstring example below). NVIDIA wheel DLL injection used
# to run as a module-load side effect of ``device`` and the original
# motivation for this early import was to fire it before ``onnx_asr``
# pulled in ORT; injection is now lazy inside ``_probe_cuda_session`` so
# this import is no longer load-bearing for DLL ordering. Silero is also
# CPU-pinned (see ``memory/project_silero_vad_cpu_pin_invariant.md``) so
# it never asks for CUDA in the first place — keeping the import only to
# avoid silently re-introducing a transitive ordering bug if a future
# refactor lets Silero pick a non-CPU EP.
from src.recorder.infrastructure import device as _device  # noqa: F401

if TYPE_CHECKING:
    import onnxruntime as rt

#: Silero v5 hop size (fresh samples per inference) at 16 kHz / 8 kHz.
_HOP_16K = 512
_HOP_8K = 256
#: Silero v5 context size (samples carried over from prior hop) at 16 kHz / 8 kHz.
_CONTEXT_16K = 64
_CONTEXT_8K = 32
_INT16_MAX_ABS_VALUE = 32768.0
_STATE_SHAPE = (2, 1, 128)


class SileroVAD(IVoiceActivityDetector):
    """ONNX-only Silero VAD wrapping the ``onnx-asr`` Silero export."""

    def __init__(
        self,
        *,
        sensitivity: float = 0.4,
        sample_rate: int = 16000,
        use_onnx: bool = True,
        providers: list[str] | None = None,
    ) -> None:
        """Load the Silero ONNX model via ``onnx_asr.load_vad("silero")``.

        Args:
            sensitivity: Detection sensitivity in [0, 1]. Higher = trip more easily.
            sample_rate: 16000 or 8000.
            use_onnx: Ignored. Kept in the signature so the bootstrap call
                site keeps compiling unchanged; this adapter is always ONNX.
            providers: ORT execution provider list (e.g. from
                :func:`device.providers_for_device`). When ``None``,
                onnx-asr defaults to ``rt.get_available_providers()``,
                which on a GPU build registers CUDA — ORT then tries to
                create the CUDA EP, succeeding loudly or failing loudly
                depending on the DLL chain. Pass the same pinned list the
                transcriber uses so VAD load is silent on CPU-only boxes
                and CUDA-clean on GPU boxes.
        """
        import onnx_asr

        self._sensitivity = sensitivity
        self._sample_rate = sample_rate
        if sample_rate == 16000:
            self._hop = _HOP_16K
            self._context = _CONTEXT_16K
        else:
            self._hop = _HOP_8K
            self._context = _CONTEXT_8K
        load_kwargs: dict[str, Any] = {}
        if providers is not None:
            load_kwargs["providers"] = providers
        vad = onnx_asr.load_vad("silero", **load_kwargs)
        # ``vad._model`` is the underlying ORT InferenceSession from onnx-asr's
        # SileroVad implementation. We drive it directly here to keep per-frame
        # detection semantics (the public ``segment_batch`` API is batch-oriented).
        self._model: rt.InferenceSession = vad._model  # type: ignore[attr-defined]
        self._state: NDArray[np.float32] = np.zeros(_STATE_SHAPE, dtype=np.float32)
        # Last `_context` samples of the previous hop, prepended to the next
        # window. Initialized to zeros so the very first window is fully padded
        # (matches onnx-asr's `_encode` first-frame behaviour).
        self._context_buf: NDArray[np.float32] = np.zeros(self._context, dtype=np.float32)
        # Residual samples that didn't form a full hop yet.
        self._tail: NDArray[np.float32] = np.zeros(0, dtype=np.float32)
        self._last_prob = 0.0

    @property
    def sensitivity(self) -> float:
        return self._sensitivity

    @sensitivity.setter
    def sensitivity(self, value: float) -> None:
        self._sensitivity = value

    @override
    def detect(self, chunk: AudioChunk) -> VADResult:
        """Return per-chunk speech probability.

        Chunks shorter than the model's hop size are buffered until a full
        frame is available. The most recent probability is returned for
        partial-frame calls (keeps the caller's per-tick state stable).
        """
        # int16 PCM bytes → float32 [-1, 1]
        audio = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / _INT16_MAX_ABS_VALUE
        # Append to whatever's left from prior chunks.
        if self._tail.size:
            audio = np.concatenate([self._tail, audio])

        last_prob = self._last_prob
        offset = 0
        while audio.size - offset >= self._hop:
            hop = audio[offset : offset + self._hop]
            # Silero v5 window = [last hop's tail (context) | this hop's samples]
            frame = np.concatenate([self._context_buf, hop]).reshape(1, -1)
            output, new_state = self._model.run(
                ["output", "stateN"],
                {"input": frame, "state": self._state, "sr": np.array(self._sample_rate, dtype=np.int64)},
            )
            self._state = new_state
            last_prob = float(output.squeeze())
            # The last `_context` samples of this hop become context for the next.
            self._context_buf = hop[-self._context :].copy()
            offset += self._hop

        # Stash residual samples for the next call.
        self._tail = audio[offset:].copy() if audio.size > offset else np.zeros(0, dtype=np.float32)
        self._last_prob = last_prob
        is_speech = last_prob > (1 - self._sensitivity)
        return VADResult(is_speech=is_speech, confidence=last_prob)

    @override
    def reset(self) -> None:
        """Zero the LSTM state, context window, and residual buffer."""
        self._state = np.zeros(_STATE_SHAPE, dtype=np.float32)
        self._context_buf = np.zeros(self._context, dtype=np.float32)
        self._tail = np.zeros(0, dtype=np.float32)
        self._last_prob = 0.0

    def close(self) -> int:
        """Release the ORT session (optional — fires on GC anyway)."""
        from onnx_asr._session_cleanup import release_inference_sessions

        return release_inference_sessions(self)
