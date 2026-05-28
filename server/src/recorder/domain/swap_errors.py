"""Classification of raw model-swap exceptions into user-facing categories.

When a swap fails, the user needs to know **why**: no internet, model
not found, GPU out of memory, disk full, corrupted weights, etc. Each
of those has a different actionable response. Raw stringified
exceptions like ``LocalEntryNotFoundError: …`` aren't actionable.

This module owns the mapping. ``classify_swap_error(exc)`` inspects the
exception (by type name + message text, no library imports — keeps the
domain layer dependency-free) and returns a :class:`SwapErrorInfo`
carrying a stable category code, a human-readable message for the
toast, and the technical detail for the log line.

Adding a new category: extend :class:`SwapErrorCategory`, add a matcher
branch in ``classify_swap_error``, and (frontend side) add the
translation key.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

from src.recorder.domain.errors import DownloadCancelledError


class SwapErrorCategory(enum.StrEnum):
    """Stable codes shared between server and renderer.

    The string value is what gets sent over the wire; the renderer
    looks it up in its translations dictionary to pick the localised
    message + icon. Don't rename existing values without coordinating
    with the frontend.
    """

    CANCELLED = "cancelled"
    NETWORK = "network"
    MODEL_NOT_FOUND = "model_not_found"
    INCOMPATIBLE_QUANTIZATION = "incompatible_quantization"
    MODEL_CORRUPT = "model_corrupt"
    OUT_OF_MEMORY = "out_of_memory"
    DISK_FULL = "disk_full"
    PERMISSION_DENIED = "permission_denied"
    SUPERSEDED = "superseded"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class SwapErrorInfo:
    """Classified swap failure with a user-readable message + technical detail."""

    category: SwapErrorCategory
    user_message: str
    technical_detail: str


_NETWORK_MESSAGE = "Couldn't reach the model server. Check your internet connection and try again."

# Message-substring matchers. Each tuple is (needles, category, user_message);
# the first tuple whose any-needle is a substring of the (lowercased) exception
# text wins. Driven by a table so the matcher itself stays branch-flat.
_MESSAGE_RULES: tuple[tuple[tuple[str, ...], SwapErrorCategory, str], ...] = (
    (
        ("out of memory", "cuda_out_of_memory", "oom"),
        SwapErrorCategory.OUT_OF_MEMORY,
        "Not enough memory to load the model. Try a smaller model, switch to CPU, or close other apps.",
    ),
    (
        ("no space", "enospc", "disk full"),
        SwapErrorCategory.DISK_FULL,
        "Not enough disk space to download the model. Free up space and try again.",
    ),
    (
        ("invalidprotobuf", "invalid_protobuf", "protobuf parsing failed"),
        SwapErrorCategory.MODEL_CORRUPT,
        "The model file appears corrupted. Delete it from the cache and re-download.",
    ),
    (
        # urllib.error.URLError (and our ``RuntimeError("Failed to
        # download …")`` wrapper around it on the TTS pack/model path)
        # — these are the offline tells the type name can't reveal.
        (
            "failed to download",
            "urlopen error",
            "getaddrinfo failed",
            "name or service not known",
            "temporary failure in name resolution",
            "no address associated with hostname",
            "[errno 11001]",
            "network is unreachable",
            "connection refused",
        ),
        SwapErrorCategory.NETWORK,
        _NETWORK_MESSAGE,
    ),
)

# Exact exception-class-name matchers. Maps a frozenset of class names to the
# (category, user_message) they classify as.
_TYPE_NAME_RULES: tuple[tuple[frozenset[str], SwapErrorCategory, str], ...] = (
    (
        frozenset(
            {
                # requests / urllib3 / urllib names (still reachable —
                # ``requests`` stays in the venv for openwakeword + the TTS
                # asset downloader's urllib path).
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
                # httpx names — huggingface_hub 1.x switched its HTTP backend
                # from ``requests`` to ``httpx``, so a transport-level failure
                # mid-download now surfaces with these class names instead of
                # the requests ones above. ``HfHubHTTPError`` still wraps most
                # status errors, but a raw connection drop / DNS failure / read
                # timeout escapes as the bare httpx type — bucket them NETWORK.
                "ConnectError",
                "TimeoutException",
                "WriteTimeout",
                "PoolTimeout",
                "NetworkError",
                "ReadError",
                "WriteError",
                "ProxyError",
                "RemoteProtocolError",
            }
        ),
        SwapErrorCategory.NETWORK,
        _NETWORK_MESSAGE,
    ),
    (
        frozenset({"LocalEntryNotFoundError"}),
        SwapErrorCategory.NETWORK,
        "The model isn't downloaded yet and the server can't be reached. Connect to the internet and try again.",
    ),
    (
        frozenset({"RepositoryNotFoundError", "GatedRepoError", "RevisionNotFoundError"}),
        SwapErrorCategory.MODEL_NOT_FOUND,
        "The selected model couldn't be found on Hugging Face. It may have been removed or renamed.",
    ),
    (
        frozenset({"EntryNotFoundError"}),
        SwapErrorCategory.INCOMPATIBLE_QUANTIZATION,
        "The requested precision isn't available for this model. Switch quantization to Auto and try again.",
    ),
    (
        frozenset({"PermissionError"}),
        SwapErrorCategory.PERMISSION_DENIED,
        "Permission denied while writing the model cache. Check the cache folder's permissions.",
    ),
)


def _text_matches(text: str, needles: tuple[str, ...]) -> bool:
    return any(needle in text for needle in needles)


def _classify_by_message(name: str, text: str, exc: BaseException) -> SwapErrorInfo | None:
    """Second-pass matcher: inspects the exception *message* for tells
    that the type name alone can't reveal (CUDA OOM, ENOSPC, etc.)."""
    for needles, category, message in _MESSAGE_RULES:
        if _text_matches(text, needles):
            return SwapErrorInfo(category, message, f"{name}: {exc}")
    return None


def _classify_by_type_name(name: str, exc: BaseException) -> SwapErrorInfo | None:
    """First-pass matcher: exception class name is enough to bucket
    most huggingface_hub / onnxruntime / httpx / requests failures."""
    for names, category, message in _TYPE_NAME_RULES:
        if name in names:
            return SwapErrorInfo(category, message, f"{name}: {exc}")
    return None


def _classify_cancelled(exc: BaseException) -> SwapErrorInfo | None:
    if isinstance(exc, DownloadCancelledError):
        return SwapErrorInfo(SwapErrorCategory.CANCELLED, "Model download was cancelled.", str(exc))
    return None


def _first_match(candidates: tuple[SwapErrorInfo | None, ...]) -> SwapErrorInfo | None:
    """First non-``None`` classification, or ``None`` if none matched."""
    for info in candidates:
        if info is not None:
            return info
    return None


def classify_swap_error(exc: BaseException) -> SwapErrorInfo:
    """Map a raw exception to a category + user-readable message.

    The function never raises and never imports library code — it
    inspects ``type(exc).__name__`` and ``str(exc)`` only. Library
    exceptions are matched by stable class name so this stays usable
    even when the underlying library version bumps.
    """
    name = type(exc).__name__
    text = str(exc).lower()
    matched = _first_match(
        (
            _classify_cancelled(exc),
            _classify_by_type_name(name, exc),
            _classify_by_message(name, text, exc),
        )
    )
    if matched is not None:
        return matched
    return SwapErrorInfo(
        SwapErrorCategory.UNKNOWN,
        f"Model load failed ({name}). See the server log for details.",
        f"{name}: {exc}",
    )


def superseded_info(name: str) -> SwapErrorInfo:
    """Helper for the supersede path — a newer swap arrived before this
    one committed. Not really an error, but the renderer still wants a
    structured payload to know which model dropped out."""
    return SwapErrorInfo(
        SwapErrorCategory.SUPERSEDED,
        "Switched to a newer selection before this model finished loading.",
        f"superseded: {name}",
    )
