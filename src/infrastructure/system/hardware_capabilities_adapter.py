"""Infrastructure adapter for hardware/model acceleration capabilities.

This adapter encapsulates runtime-specific checks (e.g., onnxruntime providers)
and exposes them via the IHardwareCapabilitiesPort so that UI/domain do not
import heavy libraries.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from src.domain.system_integration.ports.hardware_capabilities_port import (
    IHardwareCapabilitiesPort,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from src.domain.common.ports.logging_port import LoggingPort


class OnnxHardwareCapabilitiesAdapter(IHardwareCapabilitiesPort):
    """ONNX runtime-based capabilities adapter."""

    def __init__(self, logger: LoggingPort | None = None):
        self._logger = logger

    def has_gpu_acceleration(self) -> bool:
        try:
            import onnxruntime as ort  # Runtime-only import
            providers = ort.get_available_providers()
            has = any(p in providers for p in ["CUDAExecutionProvider", "DmlExecutionProvider"])
            if self._logger:
                self._logger.log_debug(f"ONNX providers: {providers}, has_gpu={has}")
            return has
        except Exception as e:
            if self._logger:
                self._logger.log_warning(f"Hardware capabilities check failed: {e}")
            return False

    def get_available_providers(self) -> Sequence[str]:
        try:
            import onnxruntime as ort  # Runtime-only import
            return tuple(ort.get_available_providers())
        except Exception:
            return ()


