"""
Model Instance Entity

Represents a transcription model instance with configuration and state.
Extracted from WhisperONNXTranscriber model management logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from src_refactored.domain.common.abstractions import DomainEvent, Entity
from src_refactored.domain.settings.value_objects.model_configuration import ModelType, Quantization


class ModelState(Enum):
    """State of the model instance."""
    UNINITIALIZED = "uninitialized"
    DOWNLOADING = "downloading"
    INITIALIZING = "initializing"
    READY = "ready"
    FAILED = "failed"
    UPDATING = "updating"


class ModelSize(Enum):
    """Model size categories."""
    TINY = "tiny"
    BASE = "base"
    SMALL = "small"
    MEDIUM = "medium"
    LARGE = "large"


@dataclass(frozen=True)
class ModelLoadedEvent(DomainEvent):
    """Domain event fired when model is loaded."""
    model_id: str
    model_type: ModelType
    quantization: Quantization
    load_time_seconds: float


@dataclass(frozen=True)
class ModelDownloadProgressEvent(DomainEvent):
    """Domain event fired during model download."""
    model_id: str
    progress_percentage: float
    downloaded_bytes: int
    total_bytes: int | None


@dataclass(frozen=True)
class ModelFailedEvent(DomainEvent):
    """Domain event fired when model fails to load."""
    model_id: str
    error_message: str
    error_code: str


@dataclass
class ModelInstance(Entity):
    """
    Entity representing a transcription model instance.
    
    Manages model configuration, state, and lifecycle including
    downloading, loading, and validation.
    """
    model_type: ModelType
    quantization: Quantization
    cache_path: str
    state: ModelState = ModelState.UNINITIALIZED
    language: str = "auto"
    task: str = "transcribe"
    loaded_at: datetime | None = None
    last_used: datetime | None = None
    version: str = ""
    config_parameters: dict[str, Any] = field(default_factory=dict)
    download_progress: float = 0.0
    error_message: str | None = None

    def __post_init__(self):
        super().__post_init__()

        # Validate task
        if self.task not in ["transcribe", "translate"]:
            msg = f"Invalid task: {self.task}. Must be 'transcribe' or 'translate'"
            raise ValueError(msg)

        # Validate language code
        if self.language != "auto" and len(self.language) != 2:
            msg = f"Language must be 'auto' or 2-character code, got: {self.language}"
            raise ValueError(msg)

    def start_download(self) -> None:
        """
        Start model download process.
        Business rule: Can only start download from UNINITIALIZED state.
        """
        if self.state != ModelState.UNINITIALIZED:
            msg = f"Cannot start download from state: {self.state}"
            raise ValueError(msg)

        self.state = ModelState.DOWNLOADING
        self.download_progress = 0.0
        self.error_message = None
        self.update_timestamp()

    def update_download_progress(self,
    progress_percentage: float, downloaded_bytes: int, total_bytes: int | None = None) -> None:
        """
        Update download progress.
        Business rule: Can only update progress while downloading.
        """
        if self.state != ModelState.DOWNLOADING:
            msg = f"Cannot update download progress in state: {self.state}"
            raise ValueError(msg)

        if not 0.0 <= progress_percentage <= 100.0:
            msg = f"Progress percentage must be 0-100, got: {progress_percentage}"
            raise ValueError(msg)

        self.download_progress = progress_percentage
        self.update_timestamp()

        # Raise domain event
        ModelDownloadProgressEvent(
            event_id="",
            timestamp=0.0,
            source="ModelInstance",
            model_id=self.entity_id,
            progress_percentage=progress_percentage,
            downloaded_bytes=downloaded_bytes,
            total_bytes=total_bytes,
        )
        # Note: In real implementation, this would be added to an event collection

    def complete_download(self) -> None:
        """
        Complete download and start initialization.
        Business rule: Can only complete from DOWNLOADING state.
        """
        if self.state != ModelState.DOWNLOADING:
            msg = f"Cannot complete download from state: {self.state}"
            raise ValueError(msg)

        self.state = ModelState.INITIALIZING
        self.download_progress = 100.0
        self.update_timestamp()

    def complete_initialization(self, version: str, config_params: dict[str, Any]) -> None:
        """
        Complete model initialization.
        Business rule: Can only complete from INITIALIZING state.
        """
        if self.state != ModelState.INITIALIZING:
            msg = f"Cannot complete initialization from state: {self.state}"
            raise ValueError(msg)

        self.state = ModelState.READY
        self.loaded_at = datetime.now()
        self.version = version
        self.config_parameters = config_params.copy()
        self.error_message = None
        self.update_timestamp()

        # Calculate load time
        load_time = (datetime.now() - self.created_at).total_seconds() if hasattr(self, "created_at") else 0.0

        # Raise domain event
        ModelLoadedEvent(
            event_id="",
            timestamp=0.0,
            source="ModelInstance",
            model_id=self.entity_id,
            model_type=self.model_type,
            quantization=self.quantization,
            load_time_seconds=load_time,
        )
        # Note: In real implementation, this would be added to an event collection

    def fail_loading(self, error_message: str, error_code: str = "MODEL_LOAD_ERROR") -> None:
        """Fail model loading with error."""
        self.state = ModelState.FAILED
        self.error_message = error_message
        self.update_timestamp()

        # Raise domain event
        ModelFailedEvent(
            event_id="",
            timestamp=0.0,
            source="ModelInstance",
            model_id=self.entity_id,
            error_message=error_message,
            error_code=error_code,
        )
        # Note: In real implementation, this would be added to an event collection

    def mark_used(self) -> None:
        """Mark model as used (update last used timestamp)."""
        if self.state != ModelState.READY:
            msg = f"Cannot use model in state: {self.state}"
            raise ValueError(msg)

        self.last_used = datetime.now()
        self.update_timestamp()

    def start_update(self) -> None:
        """
        Start model update process.
        Business rule: Can only update from READY state.
        """
        if self.state != ModelState.READY:
            msg = f"Cannot update model from state: {self.state}"
            raise ValueError(msg)

        self.state = ModelState.UPDATING
        self.update_timestamp()

    def update_configuration(self, language: str, task: str,
    ) -> None:
        """
        Update model configuration.
        Business rule: Can only update config when ready.
        """
        if self.state != ModelState.READY:
            msg = f"Cannot update configuration in state: {self.state}"
            raise ValueError(msg)

        # Validate new parameters
        if task not in ["transcribe", "translate"]:
            msg = f"Invalid task: {task}"
            raise ValueError(msg)

        if language != "auto" and len(language) != 2:
            msg = f"Invalid language code: {language}"
            raise ValueError(msg)

        self.language = language
        self.task = task
        self.update_timestamp()

    @property
    def is_ready(self) -> bool:
        """Check if model is ready for use."""
        return self.state == ModelState.READY

    @property
    def is_loading(self) -> bool:
        """Check if model is currently loading."""
        return self.state in [ModelState.DOWNLOADING, ModelState.INITIALIZING]

    @property
    def has_failed(self) -> bool:
        """Check if model loading has failed."""
        return self.state == ModelState.FAILED

    @property
    def model_cache_directory(self) -> Path:
        """Get model cache directory path."""
        if self.model_type == ModelType.LITE_WHISPER_TURBO:
            model_dir = "lite-whisper-turbo"
        elif self.model_type == ModelType.LITE_WHISPER_TURBO_FAST:
            model_dir = "lite-whisper-turbo-fast"
        else:
            model_dir = "whisper-turbo"

        return Path(self.cache_path) / "models" / model_dir

    @property
    def onnx_directory(self) -> Path:
        """Get ONNX files directory."""
        return self.model_cache_directory / "onnx"

    @property
    def estimated_memory_usage_mb(self) -> float:
        """Estimate memory usage in MB."""
        base_memory = {
            ModelType.WHISPER_TURBO: 1000.0,
            ModelType.LITE_WHISPER_TURBO: 600.0,
            ModelType.LITE_WHISPER_TURBO_FAST: 300.0,
        }

        memory = base_memory.get(self.model_type, 1000.0)

        # Quantized models use less memory
        if self.quantization == Quantization.QUANTIZED:
            memory *= 0.6

        return memory

    @property
    def estimated_disk_usage_mb(self) -> float:
        """Estimate disk usage in MB."""
        base_sizes = {
            ModelType.WHISPER_TURBO: 244.0,
            ModelType.LITE_WHISPER_TURBO: 152.0,
            ModelType.LITE_WHISPER_TURBO_FAST: 65.0,
        }

        size = base_sizes.get(self.model_type, 244.0)

        # Quantized models are smaller
        if self.quantization == Quantization.QUANTIZED:
            size *= 0.5

        return size

    @property
    def is_gpu_compatible(self) -> bool:
        """Check if model is compatible with GPU acceleration."""
        return self.quantization == Quantization.FULL

    @property
    def supports_language(self) -> bool:
        """Check if model supports the configured language."""
        # Most Whisper models support multiple languages
        # Auto-detect is always supported
        return True

    @property
    def encoder_filename(self) -> str:
        """Get encoder ONNX filename."""
        if self.quantization == Quantization.FULL:
            return "encoder_model.onnx"
        return f"encoder_model_{self.quantization.value.lower()}.onnx"

    @property
    def decoder_filename(self) -> str:
        """Get decoder ONNX filename."""
        if self.quantization == Quantization.FULL:
            return "decoder_model_merged.onnx"
        return f"decoder_model_merged_{self.quantization.value.lower()}.onnx"

    def get_file_paths(self) -> dict[str, Path]:
        """Get all required file paths for the model."""
        base_dir = self.model_cache_directory
        onnx_dir = self.onnx_directory

        return {
            "config": base_dir / "config.json",
            "generation_config": base_dir / "generation_config.json",
            "preprocessor_config": base_dir / "preprocessor_config.json",
            "tokenizer": base_dir / "tokenizer.json",
            "encoder": onnx_dir / self.encoder_filename,
            "decoder": onnx_dir / self.decoder_filename,
        }

    def validate_files_exist(self) -> bool:
        """Validate that all required model files exist."""
        file_paths = self.get_file_paths()

        for file_type, file_path in file_paths.items():
            if not file_path.exists():
                return False

            # Basic size check for ONNX files
            if file_type in ["encoder", "decoder"] and file_path.stat().st_size < 1000:
                return False

        return True

    @property
    def usage_statistics(self) -> dict[str, Any]:
        """Get usage statistics for the model."""
        return {
            "total_usage_time": (datetime.now() - self.loaded_at).total_seconds() if self.loaded_at else 0,
            "last_used": self.last_used.isoformat() if self.last_used else None,
            "state": self.state.value,
            "language": self.language,
            "task": self.task,
            "quantization": self.quantization.value,
            "estimated_memory_mb": self.estimated_memory_usage_mb,
            "estimated_disk_mb": self.estimated_disk_usage_mb,
        }