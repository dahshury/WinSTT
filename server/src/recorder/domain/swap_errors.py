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

from dataclasses import dataclass
from enum import Enum

from src.recorder.domain.errors import DownloadCancelledError


class SwapErrorCategory(str, Enum):
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


def _network_info(name: str, exc: BaseException) -> SwapErrorInfo:
    return SwapErrorInfo(
        SwapErrorCategory.NETWORK,
        "Couldn't reach the model server. Check your internet connection and try again.",
        f"{name}: {exc}",
    )


def _classify_by_message(name: str, text: str, exc: BaseException) -> SwapErrorInfo | None:
    """Second-pass matcher: inspects the exception *message* for tells
    that the type name alone can't reveal (CUDA OOM, ENOSPC, etc.)."""
    # CUDA / generic OOM. The torch-free build hands these through ORT,
    # whose error text includes "out of memory" verbatim.
    if "out of memory" in text or "cuda_out_of_memory" in text or "oom" in text:
        return SwapErrorInfo(
            SwapErrorCategory.OUT_OF_MEMORY,
            "Not enough memory to load the model. Try a smaller model, switch to CPU, or close other apps.",
            f"{name}: {exc}",
        )
    # ENOSPC may come through as OSError on Windows or PermissionError
    # depending on the cache path's owner.
    if "no space" in text or "enospc" in text or "disk full" in text:
        return SwapErrorInfo(
            SwapErrorCategory.DISK_FULL,
            "Not enough disk space to download the model. Free up space and try again.",
            f"{name}: {exc}",
        )
    # ORT's own complaint about a malformed graph.
    if "invalidprotobuf" in text or "invalid_protobuf" in text or "protobuf parsing failed" in text:
        return SwapErrorInfo(
            SwapErrorCategory.MODEL_CORRUPT,
            "The model file appears corrupted. Delete it from the cache and re-download.",
            f"{name}: {exc}",
        )
    return None


def _classify_by_type_name(name: str, exc: BaseException) -> SwapErrorInfo | None:
    """First-pass matcher: exception class name is enough to bucket
    most huggingface_hub / onnxruntime / requests failures."""
    # Network connectivity / HTTP.
    if name in {
        "ConnectionError",
        "ConnectTimeout",
        "ReadTimeout",
        "Timeout",
        "NewConnectionError",
        "MaxRetryError",
        "SSLError",
    }:
        return _network_info(name, exc)
    if name == "LocalEntryNotFoundError":
        return SwapErrorInfo(
            SwapErrorCategory.NETWORK,
            "The model isn't downloaded yet and the server can't be reached. Connect to the internet and try again.",
            f"{name}: {exc}",
        )
    if name == "HfHubHTTPError":
        return _network_info(name, exc)
    # Repo / file lookups on Hugging Face.
    if name in {"RepositoryNotFoundError", "GatedRepoError", "RevisionNotFoundError"}:
        return SwapErrorInfo(
            SwapErrorCategory.MODEL_NOT_FOUND,
            "The selected model couldn't be found on Hugging Face. It may have been removed or renamed.",
            f"{name}: {exc}",
        )
    if name == "EntryNotFoundError":
        # A *file* within an existing repo isn't there — almost always a
        # quantization variant the upstream hasn't published.
        return SwapErrorInfo(
            SwapErrorCategory.INCOMPATIBLE_QUANTIZATION,
            "The requested precision isn't available for this model. Switch quantization to Auto and try again.",
            f"{name}: {exc}",
        )
    if name == "PermissionError":
        return SwapErrorInfo(
            SwapErrorCategory.PERMISSION_DENIED,
            "Permission denied while writing the model cache. Check the cache folder's permissions.",
            f"{name}: {exc}",
        )
    return None


def classify_swap_error(exc: BaseException) -> SwapErrorInfo:
    """Map a raw exception to a category + user-readable message.

    The function never raises and never imports library code — it
    inspects ``type(exc).__name__`` and ``str(exc)`` only. Library
    exceptions are matched by stable class name so this stays usable
    even when the underlying library version bumps.
    """
    if isinstance(exc, DownloadCancelledError):
        return SwapErrorInfo(
            SwapErrorCategory.CANCELLED,
            "Model download was cancelled.",
            str(exc),
        )

    name = type(exc).__name__
    text = str(exc).lower()

    info = _classify_by_type_name(name, exc)
    if info is not None:
        return info
    info = _classify_by_message(name, text, exc)
    if info is not None:
        return info

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
