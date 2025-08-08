"""Model Download Service for managing ML model downloads.

This module provides infrastructure services for downloading and managing
Whisper ONNX models and VAD models with progress tracking and validation.

Extracted from: utils/transcribe.py
"""

import json
import logging
import os
from pathlib import Path

import requests  # type: ignore[import-untyped]
from PyQt6.QtCore import QObject, pyqtSignal

from src_refactored.domain.transcription.value_objects.download_progress import DownloadProgress
from src_refactored.domain.transcription.value_objects.model_download_config import (
    ModelDownloadConfig,
)

# Domain value objects are now imported from domain layer


class ModelDownloadService(QObject):
    """Service for downloading and managing ML models.
    
    Provides infrastructure for downloading Whisper ONNX models and VAD models
    with progress tracking, validation, and error handling.
    """

    # PyQt signals for progress tracking
    download_progress = pyqtSignal(DownloadProgress)
    download_completed = pyqtSignal(str)  # filename
    download_failed = pyqtSignal(str, str)  # filename, error_message

    def __init__(self, config: ModelDownloadConfig,
    ):
        super().__init__()
        self.config = config
        self.logger = logging.getLogger(__name__)

        # Create cache directories
        self.cache_path = Path(config.cache_path)
        self.onnx_folder = self.cache_path / "onnx"
        self.vad_folder = self.cache_path / "vad"

        os.makedirs(self.onnx_folder, exist_ok=True)
        os.makedirs(self.vad_folder, exist_ok=True)

    def download_whisper_models(self) -> bool:
        """Download Whisper ONNX models and configuration files.
        
        Returns:
            bool: True if all downloads successful, False otherwise
        """
        try:
            repo_url = "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/"

            # Determine model files based on quality
            encoder_name = f"encoder_model_{self.config.quality}.onnx"
            decoder_name = f"decoder_model_{self.config.quality}.onnx"

            model_files = [
                encoder_name,
                "encoder_model.onnx_data" if self.config.quality == "full" else None,
                decoder_name,
            ]

            config_files = [
                "config.json",
                "generation_config.json",
                "preprocessor_config.json",
                "merges.txt",
                "vocab.json",
                "added_tokens.json",
                "special_tokens_map.json",
                "tokenizer_config.json",
                "normalizer.json",
            ]

            # Download ONNX model files
            for file_name in model_files:
                if file_name is not None:
                    file_path = self.onnx_folder / file_name
                    if not file_path.exists() or file_path.stat().st_size <= 2048:
                        self.logger.info("Downloading model file: {file_name}")
                        file_url = repo_url + file_name
                        if not self._download_file_with_progress(file_url, file_path, file_name):
                            return False

            # Download configuration files
            for config_file in config_files:
                config_path = self.cache_path / config_file
                config_url = f"https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/{config_file}"
                if not config_path.exists():
                    self.logger.info("Downloading config file: {config_file}")
                    if not self._download_file_with_progress(config_url, config_path, config_file):
                        return False

            self.logger.info("All Whisper models downloaded successfully")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to download Whisper models: {e}")
            self.download_failed.emit("whisper_models", str(e))
            return False

    def download_vad_model(self) -> bool:
        """Download VAD (Voice Activity Detection) model.

        Returns:
            bool: True if download successful, False otherwise
        """
        try:
            filename = "silero_vad_16k.onnx"
            model_path = self.vad_folder / filename

            if model_path.exists() and model_path.stat().st_size > 1000:
                self.logger.info("VAD model already exists: {model_path}")
                return True

            self.logger.info("Downloading VAD model to {model_path}")
            url = "https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/data/silero_vad_16k_op15.onnx?raw=true"

            return self._download_file_with_progress(url, model_path, filename)

        except Exception as e:
            self.logger.exception(f"Failed to download VAD model: {e}")
            self.download_failed.emit("vad_model", str(e))
            return False

    def _download_file_with_progress(self, url: str, save_path: Path, filename: str,
    ) -> bool:
        """Download a file with progress tracking and validation.

        Args:
            url: URL to download from
            save_path: Path to save the file
            filename: Name of the file for progress tracking

        Returns:
            bool: True if download successful, False otherwise
        """
        temp_path = save_path.with_suffix(save_path.suffix + ".tmp")

        try:
            # Check if URL is accessible
            head_response = requests.head(url, timeout=self.config.timeout)
            head_response.raise_for_status()

            # Start download
            response = requests.get(url, stream=True, timeout=self.config.timeout)
            response.raise_for_status()

            total_size = int(response.headers.get("content-length", 0))
            downloaded_size = 0

            with open(temp_path, "wb") as file:
                for data in response.iter_content(self.config.chunk_size):
                    if not data:
                        continue

                    file.write(data)
                    downloaded_size += len(data)

                    # Emit progress signal
                    percentage = int((downloaded_size / total_size) * 100) if total_size > 0 else 0
                    progress = DownloadProgress(
                        filename=filename,
                        percentage=percentage,
                        downloaded_bytes=downloaded_size,
                        total_bytes=total_size,
                    )
                    self.download_progress.emit(progress)

            # Validate downloaded file
            if self._validate_downloaded_file(temp_path, save_path):
                # Move temp file to final location
                temp_path.replace(save_path)

                # Emit completion signal
                final_progress = DownloadProgress(
                    filename=filename,
                    percentage=100,
                    downloaded_bytes=downloaded_size,
                    total_bytes=total_size,
                    is_complete=True,
                )
                self.download_progress.emit(final_progress)
                self.download_completed.emit(filename)

                self.logger.info("Successfully downloaded: {filename}")
                return True
            # Remove invalid file
            if temp_path.exists():
                temp_path.unlink()
            error_msg = f"Downloaded file failed validation: {filename}"
            self.logger.error(error_msg)
            self.download_failed.emit(filename, error_msg)
            return False

        except requests.ConnectionError as e:
            error_msg = "Failed to connect to the internet. Please check your connection."
            self.logger.exception(f"{error_msg} Error: {e}")
            self.download_failed.emit(filename, error_msg)
            self._cleanup_temp_file(temp_path)
            return False

        except requests.HTTPError as e:
            if e.response.status_code == 404:
                error_msg = f"File not found (404): {filename}"
            else:
                error_msg = f"HTTP error occurred: {e}"
            self.logger.exception(error_msg)
            self.download_failed.emit(filename, error_msg)
            self._cleanup_temp_file(temp_path)
            return False

        except requests.Timeout as e:
            error_msg = "The request timed out. Please try again later."
            self.logger.exception(f"{error_msg} Error: {e}")
            self.download_failed.emit(filename, error_msg)
            self._cleanup_temp_file(temp_path)
            return False

        except Exception as e:
            error_msg = f"An unexpected error occurred: {e}"
            self.logger.exception(error_msg)
            self.download_failed.emit(filename, error_msg)
            self._cleanup_temp_file(temp_path)
            return False

    def _validate_downloaded_file(self, temp_path: Path, final_path: Path,
    ) -> bool:
        """Validate downloaded file based on its type.

        Args:
            temp_path: Path to temporary downloaded file
            final_path: Final path where file will be saved

        Returns:
            bool: True if file is valid, False otherwise
        """
        try:
            if not temp_path.exists():
                return False

            file_size = temp_path.stat().st_size

            # Basic size check
            if file_size < 100:  # Very small files are likely errors
                return False

            # JSON file validation
            if final_path.suffix == ".json":
                try:
                    with open(temp_path, encoding="utf-8") as f:
                        content = f.read()
                        # Check for HTML content in JSON file
                        if "<html" in content or "<!DOCTYPE" in content:
                            self.logger.error("Downloaded file contains HTML, not JSON: {final_path}")
                            return False
                        # Validate JSON parsing
                        json.loads(content)
                except json.JSONDecodeError as e:
                    self.logger.exception(f"Downloaded file is not valid JSON: {final_path}, error: {e}")
                    return False

            # ONNX file validation
            elif final_path.suffix == ".onnx":
                if file_size < 1000:  # ONNX files should be larger
                    try:
                        with open(temp_path, encoding="utf-8", errors="ignore") as f:
                            content_peek = f.read(512)
                            if "<html" in content_peek or "<!DOCTYPE" in content_peek:
                                self.logger.error("Downloaded file contains HTML, not ONNX: {final_path}")
                                return False
                    except Exception:
                        pass  # Binary files might not be readable as text

            return True

        except Exception as e:
            self.logger.exception(f"Error validating file {final_path}: {e}")
            return False

    def _cleanup_temp_file(self, temp_path: Path,
    ) -> None:
        """Clean up temporary file if it exists."""
        try:
            if temp_path.exists():
                temp_path.unlink()
        except Exception:
            self.logger.warning("Failed to cleanup temp file {temp_path}: {e}")

    def get_model_status(self) -> dict[str, bool]:
        """Get status of downloaded models.

        Returns:
            Dict mapping model names to their availability status
        """
        status = {}

        # Check Whisper models
        encoder_name = f"encoder_model_{self.config.quality}.onnx"
        decoder_name = f"decoder_model_{self.config.quality}.onnx"

        encoder_path = self.onnx_folder / encoder_name
        decoder_path = self.onnx_folder / decoder_name

        status["whisper_encoder"] = encoder_path.exists() and encoder_path.stat().st_size > 2048
        status["whisper_decoder"] = decoder_path.exists() and decoder_path.stat().st_size > 2048

        # Check VAD model
        vad_path = self.vad_folder / "silero_vad_16k.onnx"
        status["vad_model"] = vad_path.exists() and vad_path.stat().st_size > 1000

        # Check config files
        config_files = ["config.json", "vocab.json", "tokenizer_config.json"]
        for config_file in config_files:
            config_path = self.cache_path / config_file
            status[f"config_{config_file.split('.')[0]}"] = config_path.exists()

        return status

    def cleanup_incomplete_downloads(self) -> None:
        """Clean up any incomplete download files (.tmp files)."""
        try:
            for folder in [self.cache_path, self.onnx_folder, self.vad_folder]:
                for temp_file in folder.glob("*.tmp"):
                    temp_file.unlink()
                    self.logger.info("Cleaned up incomplete download: {temp_file}")
        except Exception:
            self.logger.warning("Error during cleanup: {e}")