"""Property-based tests for :mod:`src.recorder.domain.swap_errors`."""

from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st

from src.recorder.domain.errors import DownloadCancelledError
from src.recorder.domain.swap_errors import (
    SwapErrorCategory,
    SwapErrorInfo,
    classify_swap_error,
    superseded_info,
)

# Class names hand-rolled to mirror real upstream library exceptions.
_TYPE_NAMES = st.sampled_from(
    [
        "ConnectionError",
        "ConnectTimeout",
        "ReadTimeout",
        "Timeout",
        "NewConnectionError",
        "MaxRetryError",
        "SSLError",
        "HfHubHTTPError",
        "URLError",
        "HTTPError",
        "LocalEntryNotFoundError",
        "RepositoryNotFoundError",
        "GatedRepoError",
        "RevisionNotFoundError",
        "EntryNotFoundError",
        "PermissionError",
        "RuntimeError",
        "OSError",
        "MemoryError",
        "ValueError",
        "TypeError",
        "WeirdRandomError",
        "ArbitraryThing",
    ]
)


def _make(name: str, message: str = "") -> Exception:
    return type(name, (Exception,), {})(message)


# Arbitrary text — including Unicode, control chars, very long strings.
_MESSAGE = st.text(min_size=0, max_size=200)


@settings(max_examples=300)
@given(_TYPE_NAMES, _MESSAGE)
def test_classify_never_raises_and_returns_info(name: str, message: str) -> None:
    exc = _make(name, message)
    info = classify_swap_error(exc)
    assert isinstance(info, SwapErrorInfo)
    assert info.user_message  # non-empty
    assert info.technical_detail  # non-empty
    assert isinstance(info.category, SwapErrorCategory)


@settings(max_examples=300)
@given(_TYPE_NAMES, _MESSAGE)
def test_classify_is_deterministic(name: str, message: str) -> None:
    exc_a = _make(name, message)
    exc_b = _make(name, message)
    info_a = classify_swap_error(exc_a)
    info_b = classify_swap_error(exc_b)
    assert info_a.category == info_b.category
    assert info_a.user_message == info_b.user_message


@settings(max_examples=300)
@given(_TYPE_NAMES, _MESSAGE)
def test_category_value_is_stable_enum(name: str, message: str) -> None:
    info = classify_swap_error(_make(name, message))
    # StrEnum value is what flows over the wire.
    assert isinstance(info.category.value, str)
    assert info.category.value
    # The value round-trips through the enum.
    assert SwapErrorCategory(info.category.value) is info.category


@settings(max_examples=200)
@given(_MESSAGE)
def test_download_cancelled_always_maps_to_cancelled(message: str) -> None:
    info = classify_swap_error(DownloadCancelledError(message))
    assert info.category == SwapErrorCategory.CANCELLED


@settings(max_examples=200)
@given(st.text(min_size=0, max_size=120))
def test_superseded_info_carries_name(name: str) -> None:
    info = superseded_info(name)
    assert info.category == SwapErrorCategory.SUPERSEDED
    assert name in info.technical_detail
