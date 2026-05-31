"""Tests for :mod:`src.recorder.domain.swap_errors`.

Exception classes are matched by *type name* (no library imports in the
domain layer), so we synthesize fake exception classes here that mirror
the names raised by huggingface_hub / onnxruntime / requests in the
wild. Renaming these is a wire-format break and would silently
mis-categorize failures, so the assertions are explicit about each
matcher.
"""

from __future__ import annotations

from src.recorder.domain.errors import DownloadCancelledError
from src.recorder.domain.swap_errors import (
    SwapErrorCategory,
    SwapErrorInfo,
    classify_swap_error,
    superseded_info,
)


def _make(name: str, message: str = "") -> Exception:
    """Build an exception whose ``type(exc).__name__`` is ``name``.

    Saves us from importing huggingface_hub / onnxruntime in the test —
    the classifier reads the class name as a string anyway.
    """
    return type(name, (Exception,), {})(message)


class TestClassifyCancelled:
    def test_download_cancelled_error_maps_to_cancelled_category(self) -> None:
        info = classify_swap_error(DownloadCancelledError("model/x"))
        assert info.category == SwapErrorCategory.CANCELLED
        assert "cancelled" in info.user_message.lower()


class TestClassifyNetwork:
    def test_connection_error_maps_to_network(self) -> None:
        info = classify_swap_error(_make("ConnectionError", "Failed to establish a new connection"))
        assert info.category == SwapErrorCategory.NETWORK
        assert "internet" in info.user_message.lower()

    def test_timeout_maps_to_network(self) -> None:
        info = classify_swap_error(_make("ReadTimeout", "Read timed out"))
        assert info.category == SwapErrorCategory.NETWORK

    def test_ssl_error_maps_to_network(self) -> None:
        info = classify_swap_error(_make("SSLError", "certificate verify failed"))
        assert info.category == SwapErrorCategory.NETWORK

    def test_urlerror_type_maps_to_network(self) -> None:
        # The TTS pack/model downloader raises urllib.error.URLError when
        # offline; classify by type name like the hf_hub failures.
        info = classify_swap_error(_make("URLError", "<urlopen error [Errno 11001] getaddrinfo failed>"))
        assert info.category == SwapErrorCategory.NETWORK
        assert "internet" in info.user_message.lower()

    def test_wrapped_download_runtimeerror_maps_to_network(self) -> None:
        # support_pack/asset_downloader wrap URLError as
        # RuntimeError("Failed to download <url>: <urlopen error ...>") —
        # the type name is RuntimeError, so the offline tell must be
        # matched from the message for the TTS install to report a clear
        # "no internet" instead of a raw trace.
        info = classify_swap_error(
            _make("RuntimeError", "Failed to download https://example/pack.zip: <urlopen error getaddrinfo failed>")
        )
        assert info.category == SwapErrorCategory.NETWORK
        assert "internet" in info.user_message.lower()

    def test_local_entry_not_found_offline_message(self) -> None:
        info = classify_swap_error(_make("LocalEntryNotFoundError", "cache miss"))
        assert info.category == SwapErrorCategory.NETWORK
        assert "internet" in info.user_message.lower()

    def test_hf_hub_http_error_maps_to_network(self) -> None:
        info = classify_swap_error(_make("HfHubHTTPError", "503 Service Unavailable"))
        assert info.category == SwapErrorCategory.NETWORK


class TestClassifyModelNotFound:
    def test_repository_not_found_maps_to_model_not_found(self) -> None:
        info = classify_swap_error(_make("RepositoryNotFoundError", "404: not found"))
        assert info.category == SwapErrorCategory.MODEL_NOT_FOUND
        assert "couldn't be found" in info.user_message.lower()

    def test_gated_repo_error_maps_to_model_not_found(self) -> None:
        info = classify_swap_error(_make("GatedRepoError", "Access to model X is restricted"))
        assert info.category == SwapErrorCategory.MODEL_NOT_FOUND

    def test_revision_not_found_maps_to_model_not_found(self) -> None:
        info = classify_swap_error(_make("RevisionNotFoundError", "Invalid revision"))
        assert info.category == SwapErrorCategory.MODEL_NOT_FOUND


class TestClassifyIncompatibleQuantization:
    def test_entry_not_found_maps_to_incompatible_quantization(self) -> None:
        """A *file* missing inside an existing repo is the typical
        symptom of asking for a quantization the upstream didn't ship."""
        info = classify_swap_error(_make("EntryNotFoundError", "encoder_model_int8.onnx was not found"))
        assert info.category == SwapErrorCategory.INCOMPATIBLE_QUANTIZATION
        assert "quantization" in info.user_message.lower()


class TestClassifyOutOfMemory:
    def test_cuda_oom_message_maps_to_oom(self) -> None:
        info = classify_swap_error(_make("RuntimeError", "CUDA out of memory; tried to allocate"))
        assert info.category == SwapErrorCategory.OUT_OF_MEMORY
        assert "memory" in info.user_message.lower()

    def test_generic_oom_substring_in_message_matches(self) -> None:
        info = classify_swap_error(_make("MemoryError", "Cannot allocate memory: OOM"))
        assert info.category == SwapErrorCategory.OUT_OF_MEMORY


class TestClassifyDiskFull:
    def test_no_space_message_maps_to_disk_full(self) -> None:
        info = classify_swap_error(_make("OSError", "[Errno 28] No space left on device"))
        assert info.category == SwapErrorCategory.DISK_FULL
        assert "disk" in info.user_message.lower()

    def test_enospc_substring_matches(self) -> None:
        info = classify_swap_error(_make("OSError", "ENOSPC: write failed"))
        assert info.category == SwapErrorCategory.DISK_FULL


class TestClassifyPermissionDenied:
    def test_permission_error_maps_to_permission_denied(self) -> None:
        info = classify_swap_error(_make("PermissionError", "Access is denied"))
        assert info.category == SwapErrorCategory.PERMISSION_DENIED


class TestClassifyModelCorrupt:
    def test_invalid_protobuf_message_maps_to_model_corrupt(self) -> None:
        info = classify_swap_error(_make("RuntimeError", "InvalidProtobuf: protobuf parsing failed"))
        assert info.category == SwapErrorCategory.MODEL_CORRUPT
        assert "corrupted" in info.user_message.lower()


class TestClassifyUnknown:
    def test_unknown_exception_kind_lands_in_unknown(self) -> None:
        info = classify_swap_error(_make("WeirdRandomError", "something blew up"))
        assert info.category == SwapErrorCategory.UNKNOWN
        # The user message includes the exception class name so the
        # report is at least somewhat actionable for support.
        assert "WeirdRandomError" in info.user_message


class TestSwapErrorInfoShape:
    def test_info_carries_user_message_and_technical_detail(self) -> None:
        info = classify_swap_error(_make("ConnectionError", "DNS failure"))
        assert isinstance(info, SwapErrorInfo)
        assert info.user_message
        assert "ConnectionError" in info.technical_detail
        assert "DNS failure" in info.technical_detail


class TestSupersededHelper:
    def test_superseded_info_returns_superseded_category(self) -> None:
        info = superseded_info("onnx-community/whisper-base")
        assert info.category == SwapErrorCategory.SUPERSEDED
        assert "onnx-community/whisper-base" in info.technical_detail
