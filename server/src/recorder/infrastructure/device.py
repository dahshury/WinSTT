"""Shared device-resolution utility for ML-based infrastructure adapters.

Decides whether a caller's ``"cuda"`` request can actually be honored by
checking which ONNX Runtime execution providers are available in the
current install. Falls back to CPU when no GPU provider (CUDA, TensorRT,
DirectML) is registered. Pure onnxruntime — no torch dependency.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_GPU_PROVIDERS = {"CUDAExecutionProvider", "TensorrtExecutionProvider", "DmlExecutionProvider"}


def resolve_device(requested: str) -> str:
    """Return the actual device to use, falling back to CPU when GPU is unavailable.

    "cuda" is honored if any GPU-class ONNX Runtime execution provider is
    available (CUDA, TensorRT, or DirectML). Non-cuda values pass through
    unchanged. This avoids a torch dependency on installs that don't have
    a GPU at all (the ``cpu`` wheel of onnxruntime).
    """
    if requested != "cuda":
        return requested
    try:
        import onnxruntime as rt
    except ImportError:
        logger.warning("CUDA requested but onnxruntime is not installed — falling back to CPU.")
        return "cpu"
    available = set(rt.get_available_providers())
    if available & _GPU_PROVIDERS:
        return "cuda"
    logger.warning(
        "CUDA requested but no GPU execution provider (CUDA / TensorRT / DirectML) is "
        "registered with onnxruntime — falling back to CPU. For GPU support install the "
        "onnxruntime-gpu wheel."
    )
    return "cpu"
