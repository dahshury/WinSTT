"""LLM infrastructure services."""

# Import with error handling for optional dependencies
try:
    from .gemma_inference_service import (
        GemmaInferenceError,
        GemmaInferenceManager,
        GemmaInferenceService,
        generate_text,
        load_model,
    )
    HAS_GEMMA_INFERENCE = True
except ImportError:
    # Create stub implementations when dependencies aren't available
    HAS_GEMMA_INFERENCE = False
    GemmaInferenceError = Exception
    GemmaInferenceManager = None
    GemmaInferenceService = None
    generate_text = None
    load_model = None

try:
    from .llm_pyqt_worker_service import LLMPyQtWorkerManager, LLMPyQtWorkerService
    from .llm_worker_service import LLMError, LLMWorkerService
    HAS_LLM_WORKERS = True
except ImportError:
    HAS_LLM_WORKERS = False
    LLMPyQtWorkerManager = None
    LLMPyQtWorkerService = None
    LLMError = Exception
    LLMWorkerService = None

__all__ = [
    "HAS_GEMMA_INFERENCE",
    "HAS_LLM_WORKERS",
    "GemmaInferenceError",
    "GemmaInferenceManager",
    "GemmaInferenceService",
    "LLMError",
    "LLMPyQtWorkerManager",
    "LLMPyQtWorkerService",
    "LLMWorkerService",
    "generate_text",
    "load_model",
]