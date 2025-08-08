"""LLM infrastructure services."""

# Import with error handling for optional dependencies
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    # Only used for type annotations; not imported at runtime
    from .gemma_inference_service import (
        GemmaInferenceManager as GemmaInferenceManagerType,
        GemmaInferenceService as GemmaInferenceServiceType,
    )
    from .llm_pyqt_worker_service import (
        LLMPyQtWorkerManager as LLMPyQtWorkerManagerType,
        LLMPyQtWorkerService as LLMPyQtWorkerServiceType,
    )
    from .llm_worker_service import (
        LLMError as LLMErrorType,
        LLMWorkerService as LLMWorkerServiceType,
    )

# Public export type annotations
HAS_GEMMA_INFERENCE: bool
HAS_LLM_WORKERS: bool

# When available these are classes (types) or functions; otherwise None/fallbacks
GemmaInferenceError: type[Exception]
GemmaInferenceManager: type["GemmaInferenceManagerType"] | None
GemmaInferenceService: type["GemmaInferenceServiceType"] | None
generate_text: Callable[[Any, Any, Any, list[dict[str, str]]], tuple[str, dict[str, Any]]] | None
load_model: Callable[[str, str | None, Any, str], tuple[Any, Any, Any]] | None

LLMPyQtWorkerManager: type["LLMPyQtWorkerManagerType"] | None
LLMPyQtWorkerService: type["LLMPyQtWorkerServiceType"] | None
LLMError: type[Exception]
LLMWorkerService: type["LLMWorkerServiceType"] | None

try:
    from .gemma_inference_service import (
        GemmaInferenceError as _GemmaInferenceError,
        GemmaInferenceManager as _GemmaInferenceManager,
        GemmaInferenceService as _GemmaInferenceService,
        generate_text as _generate_text,
        load_model as _load_model,
    )
    HAS_GEMMA_INFERENCE = True
    GemmaInferenceError = _GemmaInferenceError
    GemmaInferenceManager = _GemmaInferenceManager
    GemmaInferenceService = _GemmaInferenceService
    generate_text = _generate_text
    load_model = _load_model
except ImportError:
    HAS_GEMMA_INFERENCE = False
    GemmaInferenceError = Exception
    GemmaInferenceManager = None
    GemmaInferenceService = None
    generate_text = None
    load_model = None

try:
    from .llm_pyqt_worker_service import (
        LLMPyQtWorkerManager as _LLMPyQtWorkerManager,
        LLMPyQtWorkerService as _LLMPyQtWorkerService,
    )
    from .llm_worker_service import (
        LLMError as _LLMError,
        LLMWorkerService as _LLMWorkerService,
    )
    HAS_LLM_WORKERS = True
    LLMPyQtWorkerManager = _LLMPyQtWorkerManager
    LLMPyQtWorkerService = _LLMPyQtWorkerService
    LLMError = _LLMError  # subclass of Exception
    LLMWorkerService = _LLMWorkerService
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