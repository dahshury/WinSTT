"""Worker imports domain concepts.

This module contains domain value objects and enums for worker import configuration,
defining the core concepts for worker types and import configurations.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any


class WorkerImportType(Enum):
    """Enumeration of available worker import types."""
    VAD = "vad"
    MODEL = "model"
    LLM = "llm"
    LISTENER = "listener"
    PYQT_AUDIO = "pyqt_audio"


@dataclass
class WorkerImportConfig:
    """Configuration for worker imports."""
    worker_type: WorkerImportType
    module_path: str
    class_name: str
    factory_method: str | None = None
    dependencies: list[str] | None = None
    initialization_params: dict[str, Any] | None = None

    def __post_init__(self) -> None:
        if self.dependencies is None:
            self.dependencies = []
        if self.initialization_params is None:
            self.initialization_params = {}