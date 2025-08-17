"""Visualization Control Value Objects.

This module defines value objects for visualization control operations,
including start/stop results, phases, and configuration types.
"""

from enum import Enum


class StartResult(Enum):
    """Enumeration of start results."""
    SUCCESS = "success"
    FAILURE = "failure"
    ALREADY_RUNNING = "already_running"
    PROCESSOR_CREATION_FAILED = "processor_creation_failed"
    AUDIO_INITIALIZATION_FAILED = "audio_initialization_failed"
    SIGNAL_CONNECTION_FAILED = "signal_connection_failed"
    CANCELLED = "cancelled"


class StartPhase(Enum):
    """Enumeration of start phases."""
    INITIALIZING = "initializing"
    CHECKING_STATUS = "checking_status"
    CREATING_PROCESSOR = "creating_processor"
    CONNECTING_SIGNALS = "connecting_signals"
    STARTING_PROCESSOR = "starting_processor"
    ACTIVATING_VISUALIZATION = "activating_visualization"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class StopResult(Enum):
    """Enumeration of stop results."""
    SUCCESS = "success"
    FAILURE = "failure"
    ALREADY_STOPPED = "already_stopped"
    PROCESSOR_STOP_FAILED = "processor_stop_failed"
    SIGNAL_DISCONNECT_FAILED = "signal_disconnect_failed"
    CLEANUP_FAILED = "cleanup_failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


class StopPhase(Enum):
    """Enumeration of stop phases."""
    INITIALIZING = "initializing"
    CHECKING_STATUS = "checking_status"
    DISCONNECTING_SIGNALS = "disconnecting_signals"
    STOPPING_PROCESSOR = "stopping_processor"
    CLEANING_UP = "cleaning_up"
    DEACTIVATING_VISUALIZATION = "deactivating_visualization"
    COMPLETING = "completing"
    ERROR_HANDLING = "error_handling"


class ProcessorType(Enum):
    """Enumeration of processor types."""
    AUDIO_PROCESSOR = "audio_processor"
    REAL_TIME_PROCESSOR = "real_time_processor"
    BUFFERED_PROCESSOR = "buffered_processor"
    CUSTOM_PROCESSOR = "custom_processor"


class ShutdownStrategy(Enum):
    """Enumeration of shutdown strategies."""
    GRACEFUL = "graceful"
    IMMEDIATE = "immediate"
    FORCE = "force"
    TIMEOUT_BASED = "timeout_based"