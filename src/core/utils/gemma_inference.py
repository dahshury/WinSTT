"""Gemma Inference Module - Legacy compatibility wrapper.

This module provides backward compatibility for existing imports
from src.core.utils.gemma_inference by wrapping the new infrastructure services.
"""

# Import from the new infrastructure layer
from src_refactored.infrastructure.llm.gemma_inference_service import (
    GemmaInferenceError,
    GemmaInferenceManager,
    GemmaInferenceService,
    generate_text,
    load_model,
)

# Re-export for backward compatibility
__all__ = [
    "GemmaInferenceError",
    "GemmaInferenceManager",
    "GemmaInferenceService",
    "generate_text",
    "load_model",
]