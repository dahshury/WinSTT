"""Transcription Operations Value Objects

This module contains enums and value objects related to transcription operations,
including sorting, filtering, and validation criteria.
"""

from enum import Enum


class SortOrder(Enum):
    """Sort order for transcription history."""
    NEWEST_FIRST = "newest_first"
    OLDEST_FIRST = "oldest_first"
    DURATION_DESC = "duration_desc"
    DURATION_ASC = "duration_asc"
    CONFIDENCE_DESC = "confidence_desc"
    CONFIDENCE_ASC = "confidence_asc"


class FilterCriteria(Enum):
    """Filter criteria for transcription history."""
    ALL = "all"
    COMPLETED = "completed"
    FAILED = "failed"
    PROCESSING = "processing"
    CANCELLED = "cancelled"
    TODAY = "today"
    LAST_WEEK = "last_week"
    LAST_MONTH = "last_month"
    HIGH_CONFIDENCE = "high_confidence"
    LOW_CONFIDENCE = "low_confidence"