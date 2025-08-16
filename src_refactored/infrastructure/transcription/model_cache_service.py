"""Model cache service for managing ONNX model storage and retrieval."""

import json
import os
import shutil
from pathlib import Path
from typing import Any

from src_refactored.domain.transcription.value_objects import ProgressCallback


class ModelCacheService:
    """Infrastructure service for managing model cache operations."""

    def __init__(self, cache_path: str, progress_callback: ProgressCallback | None = None):
        """Initialize the model cache service.
        
        Args:
            cache_path: Base path for model cache storage
            progress_callback: Optional callback for progress updates
        """
        self.cache_path = Path(cache_path)
        self.progress_callback = progress_callback
        self._ensure_cache_directory()

    def _notify(self, message: str) -> None:
        """Notify progress via domain ProgressCallback signature."""
        if self.progress_callback:
            self.progress_callback(0, 0, message)

    def _ensure_cache_directory(self) -> None:
        """Ensure cache directory exists."""
        self.cache_path.mkdir(parents=True, exist_ok=True)

    def get_model_cache_path(self, model_type: str,
    ) -> Path:
        """Get the cache path for a specific model type.
        
        Args:
            model_type: Type of model (e.g., 'whisper-turbo', 'lite-whisper-turbo')
            
        Returns:
            Path to the model cache directory
        """
        return self.cache_path / "models" / model_type

    def get_onnx_folder_path(self, model_type: str,
    ) -> Path:
        """Get the ONNX folder path for a specific model type.
        
        Args:
            model_type: Type of model
            
        Returns:
            Path to the ONNX folder
        """
        return self.get_model_cache_path(model_type) / "onnx"

    def is_model_cached(self, model_type: str, quantization: str,
    ) -> bool:
        """Check if a model is already cached.
        
        Args:
            model_type: Type of model
            quantization: Quantization type ('full' or 'quantized')
            
        Returns:
            True if model is cached, False otherwise
        """
        onnx_folder = self.get_onnx_folder_path(model_type)

        # Check for required ONNX files (new naming)
        quality_suffix = "" if quantization.lower() == "full" else "_quantized"
        encoder_path = onnx_folder / f"encoder_model{quality_suffix}.onnx"
        decoder_path = onnx_folder / f"decoder_model{quality_suffix}.onnx"
        decoder_with_past_path = onnx_folder / f"decoder_with_past_model{quality_suffix}.onnx"

        # Backward-compat: accept legacy merged decoder if present
        legacy_decoder_path = onnx_folder / (
            "decoder_model_merged.onnx" if quantization.lower() == "full" else f"decoder_model_merged_{quantization.lower()}.onnx"
        )

        has_encoder = encoder_path.exists()
        has_decoder = decoder_path.exists() or legacy_decoder_path.exists()
        has_decoder_with_past = decoder_with_past_path.exists() or legacy_decoder_path.exists()

        # Consider cached if encoder exists and at least one decoder variant exists
        return has_encoder and (has_decoder or has_decoder_with_past)

    def is_config_cached(self, model_type: str,
    ) -> bool:
        """Check if model configuration files are cached.

        Args:
            model_type: Type of model

        Returns:
            True if config files are cached, False otherwise
        """
        model_cache_path = self.get_model_cache_path(model_type)

        config_files = [
            "config.json",
            "generation_config.json",
            "preprocessor_config.json",
            "tokenizer.json",
            "tokenizer_config.json",
        ]

        return all((model_cache_path / config_file).exists() for config_file in config_files)

    def load_model_config(self, model_type: str,
    ) -> dict[str, Any]:
        """Load model configuration from cache.

        Args:
            model_type: Type of model

        Returns:
            Dictionary containing model configuration

        Raises:
            FileNotFoundError: If config files are not cached
        """
        model_cache_path = self.get_model_cache_path(model_type)

        configs = {}
        config_files = {
            "config": "config.json",
            "generation_config": "generation_config.json",
            "preprocessor_config": "preprocessor_config.json",
        }

        for config_name, config_file in config_files.items():
            config_path = model_cache_path / config_file
            if not config_path.exists():
                msg = f"Config file not found: {config_path}"
                raise FileNotFoundError(msg)

            with open(config_path, encoding="utf-8") as f:
                configs[config_name] = json.load(f)

        return configs

    def clear_model_cache(self, model_type: str | None = None) -> None:
        """Clear model cache.

        Args:
            model_type: Specific model type to clear, or None to clear all
        """
        if model_type:
            model_cache_path = self.get_model_cache_path(model_type)
            if model_cache_path.exists():
                shutil.rmtree(model_cache_path)
                self._notify(f"Cleared cache for {model_type}")
        else:
            models_path = self.cache_path / "models"
            if models_path.exists():
                shutil.rmtree(models_path)
                self._notify("Cleared all model cache")

    def get_cache_size(self, model_type: str | None = None) -> int:
        """Get the size of the cache in bytes.

        Args:
            model_type: Specific model type to check, or None for total size

        Returns:
            Cache size in bytes
        """
        cache_path = self.get_model_cache_path(model_type) if model_type else self.cache_path

        if not cache_path.exists():
            return 0

        total_size = 0
        for dirpath, _dirnames, filenames in os.walk(cache_path):
            for filename in filenames:
                filepath = os.path.join(dirpath, filename)
                if os.path.isfile(filepath):
                    total_size += os.path.getsize(filepath)

        return total_size

    def list_cached_models(self) -> list[str]:
        """List all cached model types.

        Returns:
            List of cached model type names
        """
        models_path = self.cache_path / "models"
        if not models_path.exists():
            return []

        return [item.name for item in models_path.iterdir() if item.is_dir()]