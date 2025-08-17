"""Audio Data Provider Port.

Provides waveform data to visualization components without coupling the
domain to any concrete audio pipeline implementation.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.domain.audio_visualization.value_objects import WaveformData
    from src.domain.common.result import Result


class AudioDataProviderPort(ABC):
    """Port interface for providing audio waveform data."""

    @abstractmethod
    def get_next_waveform(self) -> Result[WaveformData]:
        """Get the next available waveform for visualization.

        Returns:
            Result wrapping `WaveformData` when available.
        """
        raise NotImplementedError


