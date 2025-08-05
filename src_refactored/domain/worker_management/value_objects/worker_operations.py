"""Worker Operations Value Objects

This module contains enums and value objects related to worker management operations,
including cleanup, initialization, and lifecycle management.
"""

from enum import Enum


class CleanupResult(Enum):
    """Worker cleanup results"""
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PARTIAL_SUCCESS = "partial_success"
    WORKER_NOT_FOUND = "worker_not_found"
    THREAD_STOP_FAILED = "thread_stop_failed"
    SIGNAL_DISCONNECT_FAILED = "signal_disconnect_failed"
    RESOURCE_CLEANUP_FAILED = "resource_cleanup_failed"
    TIMEOUT_EXCEEDED = "timeout_exceeded"
    FORCE_CLEANUP_REQUIRED = "force_cleanup_required"


class CleanupPhase(Enum):
    """Worker cleanup phases"""
    INITIALIZING = "initializing"
    IDENTIFYING_WORKERS = "identifying_workers"
    DISCONNECTING_SIGNALS = "disconnecting_signals"
    STOPPING_WORKERS = "stopping_workers"
    STOPPING_THREADS = "stopping_threads"
    WAITING_FOR_COMPLETION = "waiting_for_completion"
    CLEANING_RESOURCES = "cleaning_resources"
    FORCE_CLEANUP = "force_cleanup"
    GARBAGE_COLLECTION = "garbage_collection"
    VERIFYING_CLEANUP = "verifying_cleanup"
    COMPLETED = "completed"


class WorkerType(Enum):
    """Types of workers in the system"""
    TRANSCRIBER = "transcriber"
    AUDIO_PROCESSOR = "audio_processor"
    LLM = "llm"
    BACKGROUND = "background"
    VISUALIZER = "visualizer"
    ALL = "all"


class LLMInitializationResult(Enum):
    """LLM worker initialization results"""
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    MODEL_LOAD_FAILED = "model_load_failed"
    THREAD_CREATION_FAILED = "thread_creation_failed"
    SIGNAL_CONNECTION_FAILED = "signal_connection_failed"
    CONFIGURATION_ERROR = "configuration_error"
    DEPENDENCY_FAILED = "dependency_failed"
    MEMORY_INSUFFICIENT = "memory_insufficient"
    GPU_UNAVAILABLE = "gpu_unavailable"


class LLMInitializationPhase(Enum):
    """LLM worker initialization phases"""
    INITIALIZING = "initializing"
    VALIDATING_CONFIGURATION = "validating_configuration"
    CHECKING_DEPENDENCIES = "checking_dependencies"
    CLEANING_UP_EXISTING = "cleaning_up_existing"
    LOADING_MODEL = "loading_model"
    CREATING_WORKER = "creating_worker"
    CREATING_THREAD = "creating_thread"
    MOVING_TO_THREAD = "moving_to_thread"
    CONNECTING_SIGNALS = "connecting_signals"
    STARTING_WORKER = "starting_worker"
    VERIFYING_INITIALIZATION = "verifying_initialization"
    COMPLETED = "completed"


class LLMWorkerStrategy(Enum):
    """LLM worker initialization strategies"""
    CONSERVATIVE = "conservative"
    BALANCED = "balanced"
    AGGRESSIVE = "aggressive"
    STANDARD = "standard"
    LAZY_LOADING = "lazy_loading"
    PRELOAD_MODEL = "preload_model"
    GPU_OPTIMIZED = "gpu_optimized"
    MEMORY_CONSERVATIVE = "memory_conservative"
    CUSTOM = "custom"


class InitializationResult(Enum):
    """Worker initialization results"""
    SUCCESS = "success"
    FAILED = "failed"
    CANCELLED = "cancelled"
    PARTIAL_SUCCESS = "partial_success"
    VAD_INIT_FAILED = "vad_init_failed"
    MODEL_INIT_FAILED = "model_init_failed"
    LLM_INIT_FAILED = "llm_init_failed"
    LISTENER_INIT_FAILED = "listener_init_failed"
    VISUALIZER_INIT_FAILED = "visualizer_init_failed"
    DEPENDENCY_FAILED = "dependency_failed"
    CONFIGURATION_ERROR = "configuration_error"
    RESOURCE_UNAVAILABLE = "resource_unavailable"
    TIMEOUT = "timeout"


class InitializationPhase(Enum):
    """Worker initialization phases"""
    INITIALIZING = "initializing"
    VALIDATING_CONFIGURATION = "validating_configuration"
    CHECKING_DEPENDENCIES = "checking_dependencies"
    CLEANING_UP_EXISTING = "cleaning_up_existing"
    INITIALIZING_VAD = "initializing_vad"
    INITIALIZING_MODEL = "initializing_model"
    INITIALIZING_LLM = "initializing_llm"
    INITIALIZING_LISTENER = "initializing_listener"
    INITIALIZING_VISUALIZER = "initializing_visualizer"
    CONNECTING_SIGNALS = "connecting_signals"
    CREATING_WORKERS = "creating_workers"
    STARTING_WORKERS = "starting_workers"
    VERIFYING_INITIALIZATION = "verifying_initialization"
    COMPLETED = "completed"


class InitializationStrategy(Enum):
    """Worker initialization strategies"""
    DEPENDENCY_BASED = "dependency_based"
    PARALLEL = "parallel"
    SEQUENTIAL = "sequential"
    SELECTIVE = "selective"
    LAZY = "lazy"
    EAGER = "eager"


class CleanupStrategy(Enum):
    """Worker cleanup strategies"""
    GRACEFUL = "graceful"
    FORCE = "force"
    TIMEOUT_THEN_FORCE = "timeout_then_force"
    SELECTIVE = "selective"