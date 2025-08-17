"""Audio Normalization Value Objects.

This module defines value objects for audio normalization operations,
including normalization methods, results, and phases.
"""

from enum import Enum


class NormalizationMethod(Enum):
    """Enumeration of normalization methods."""
    RMS_BASED = "rms_based"
    PEAK_BASED = "peak_based"
    Z_SCORE = "z_score"
    MIN_MAX = "min_max"
    SPEECH_OPTIMIZED = "speech_optimized"
    CUSTOM = "custom"


class NormalizationResult(Enum):
    """Enumeration of normalization results."""
    SUCCESS = "success"
    FAILURE = "failure"
    INVALID_DATA = "invalid_data"
    ZERO_RMS = "zero_rms"
    EMPTY_DATA = "empty_data"
    CALCULATION_ERROR = "calculation_error"
    CANCELLED = "cancelled"


class NormalizationPhase(Enum):
    """Audio normalization phases"""
    INITIALIZING = "initializing"
    VALIDATING_DATA = "validating_data"
    CALCULATING_RMS = "calculating_rms"
    APPLYING_SCALING = "applying_scaling"
    APPLYING_CLIPPING = "applying_clipping"
    CENTERING_DATA = "centering_data"
    ANALYZING_AUDIO = "analyzing_audio"
    CALCULATING_PARAMETERS = "calculating_parameters"
    APPLYING_NORMALIZATION = "applying_normalization"
    VALIDATING_OUTPUT = "validating_output"
    COMPLETING = "completing"
    COMPLETED = "completed"
    ERROR_HANDLING = "error_handling"


class ScalingStrategy(Enum):
    """Enumeration of scaling strategies."""
    FIXED_FACTOR = "fixed_factor"
    ADAPTIVE = "adaptive"
    TARGET_RMS = "target_rms"
    TARGET_PEAK = "target_peak"
    DYNAMIC_RANGE = "dynamic_range"