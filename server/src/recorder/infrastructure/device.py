"""Shared device-resolution utility for ML-based infrastructure adapters."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def resolve_device(requested: str) -> str:
    """Return the actual device to use, falling back to CPU when CUDA is unavailable."""
    if requested != "cuda":
        return requested
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    logger.warning("CUDA requested but not available — falling back to CPU. Transcription will be slower.")
    return "cpu"
