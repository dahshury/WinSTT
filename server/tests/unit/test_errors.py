from __future__ import annotations

import pytest

from src.building_blocks.errors import (
    AudioError,
    ConfigurationError,
    DomainError,
    PipelineError,
    TranscriptionError,
    VADError,
    WakeWordError,
)


@pytest.mark.parametrize(
    "error_class",
    [AudioError, TranscriptionError, VADError, ConfigurationError, PipelineError, WakeWordError],
)
def test_inherits_from_domain_error(error_class: type[DomainError]) -> None:
    assert issubclass(error_class, DomainError)


@pytest.mark.parametrize(
    "error_class",
    [AudioError, TranscriptionError, VADError, ConfigurationError, PipelineError, WakeWordError],
)
def test_can_be_raised_and_caught_as_domain_error(error_class: type[DomainError]) -> None:
    with pytest.raises(DomainError):
        raise error_class("test")


def test_domain_error_inherits_from_exception() -> None:
    assert issubclass(DomainError, Exception)


def test_str_without_context_returns_message() -> None:
    error = DomainError("plain message")
    assert str(error) == "plain message"


def test_str_with_context_appends_formatted_context() -> None:
    error = DomainError("failed", code=42, name="audio")
    assert str(error) == "failed (code=42, name='audio')"
