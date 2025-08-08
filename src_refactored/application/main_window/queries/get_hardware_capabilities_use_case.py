"""Get Hardware Capabilities Use Case.

Exposes a simple query to check GPU/model acceleration via the hardware port.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from src_refactored.domain.system_integration.ports.hardware_capabilities_port import (
    IHardwareCapabilitiesPort,
)


@dataclass
class HardwareCapabilitiesResponse:
    has_gpu: bool
    providers: Sequence[str]


class GetHardwareCapabilitiesUseCase:
    def __init__(self, hardware_port: IHardwareCapabilitiesPort):
        self._hardware = hardware_port

    def execute(self) -> HardwareCapabilitiesResponse:
        has_gpu = self._hardware.has_gpu_acceleration()
        providers = self._hardware.get_available_providers()
        return HardwareCapabilitiesResponse(has_gpu=has_gpu, providers=providers)


