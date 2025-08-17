"""Worker Integration Component for worker coordination and management.

This module provides worker coordination functionality following the
hexagonal architecture pattern.
"""

import logging
from collections.abc import Callable
from typing import Any

from PyQt6.QtCore import QObject, QThread, QTimer, pyqtSignal
from PyQt6.QtWidgets import QMainWindow

from src.infrastructure.audio.audio_recording_service import AudioRecordingService
from src.infrastructure.llm.llm_service import LLMService
from src.infrastructure.transcription.transcription_service import TranscriptionService
from src.infrastructure.worker.worker_thread_management_service import (
    WorkerThreadManagementService,
)


class WorkerIntegrationComponent(QObject):
    """Component for managing worker integration and coordination.
    
    This component handles worker lifecycle, signal connections,
    thread management, and worker coordination.
    """

    # Signals
    worker_started = pyqtSignal(str)  # worker_type
    worker_stopped = pyqtSignal(str)  # worker_type
    worker_error = pyqtSignal(str, str)  # worker_type, error_message
    transcription_completed = pyqtSignal(str, dict)  # output_path, transcription
    transcription_progress = pyqtSignal(int)  # progress_percentage
    llm_response_ready = pyqtSignal(str)  # response_text
    recording_started = pyqtSignal()
    recording_stopped = pyqtSignal()

    def __init__(self):
        super().__init__()
        self.logger = logging.getLogger(__name__)
        self.worker_service = WorkerThreadManagementService()
        self.transcription_service = TranscriptionService()
        self.llm_service = LLMService()
        self.audio_service = AudioRecordingService()

        # Worker references
        self.workers: dict[str, Any] = {}
        self.worker_threads: dict[str, QThread] = {}

        # State tracking
        self.is_transcribing = False
        self.is_recording = False
        self.transcription_queue = []
        self.current_file_index = 0
        self.total_files_count = 0

        # Configuration
        self.config: dict[str, Any] = {}

        # Callbacks
        self.progress_callback: Callable | None = None
        self.completion_callback: Callable | None = None
        self.error_callback: Callable | None = None

    def setup_workers(self, main_window: QMainWindow, config: dict[str, Any]) -> None:
        """Setup all workers for the main window.
        
        Args:
            main_window: The main window
            config: Configuration dictionary
        """
        self.logger.info("🔧 Setting up worker integration...")

        try:
            # Store configuration
            self.config = config

            # Initialize workers
            self._initialize_transcription_worker()
            self._initialize_llm_worker()
            self._initialize_listener_worker()

            # Setup signal connections
            self._setup_signal_connections()

            # Configure worker settings
            self._configure_worker_settings()

            self.logger.info("✅ Worker integration setup complete")

        except Exception as e:
            self.logger.exception(f"Failed to setup workers: {e}")
            self.worker_error.emit("setup", str(e))

    def _initialize_transcription_worker(self) -> None:
        """Initialize the transcription worker."""
        try:
            # Create transcription worker thread
            worker_thread = QThread()
            worker = self.transcription_service.create_worker()

            # Move worker to thread
            worker.moveToThread(worker_thread)

            # Store references
            self.workers["transcription"] = worker
            self.worker_threads["transcription"] = worker_thread

            # Connect signals
            worker.transcription_completed.connect(self._handle_transcription_completed)
            worker.transcription_error.connect(self._handle_transcription_error)
            worker.progress_updated.connect(self._handle_transcription_progress)

            # Start thread
            worker_thread.start()

            self.logger.debug("Transcription worker initialized")

        except Exception as e:
            self.logger.exception(f"Failed to initialize transcription worker: {e}")
            raise

    def _initialize_llm_worker(self) -> None:
        """Initialize the LLM worker."""
        try:
            # Create LLM worker thread
            worker_thread = QThread()
            worker = self.llm_service.create_worker()

            # Move worker to thread
            worker.moveToThread(worker_thread)

            # Store references
            self.workers["llm"] = worker
            self.worker_threads["llm"] = worker_thread

            # Connect signals
            worker.response_ready.connect(self._handle_llm_response)
            worker.error_occurred.connect(self._handle_llm_error)
            worker.progress_updated.connect(self._handle_llm_progress)

            # Start thread
            worker_thread.start()

            self.logger.debug("LLM worker initialized")

        except Exception as e:
            self.logger.exception(f"Failed to initialize LLM worker: {e}")
            raise

    def _initialize_listener_worker(self) -> None:
        """Initialize the audio listener worker."""
        try:
            # Create listener worker thread
            worker_thread = QThread()
            worker = self.audio_service.create_worker()

            # Move worker to thread
            worker.moveToThread(worker_thread)

            # Store references
            self.workers["listener"] = worker
            self.worker_threads["listener"] = worker_thread

            # Connect signals
            worker.recording_started.connect(self._handle_recording_started)
            worker.recording_stopped.connect(self._handle_recording_stopped)
            worker.audio_data_ready.connect(self._handle_audio_data)
            worker.error_occurred.connect(self._handle_listener_error)

            # Start thread
            worker_thread.start()

            self.logger.debug("Listener worker initialized")

        except Exception as e:
            self.logger.exception(f"Failed to initialize listener worker: {e}")
            raise

    def _setup_signal_connections(self) -> None:
        """Setup signal connections between workers."""
        # Connect internal signals
        self.transcription_completed.connect(self._on_transcription_completed)
        self.worker_error.connect(self._on_worker_error)

        self.logger.debug("Signal connections established")

    def _configure_worker_settings(self) -> None:
        """Configure worker settings from configuration."""
        try:
            # Configure transcription worker
            if "transcription" in self.workers:
                transcription_config = self.config.get("transcription", {})
                self.workers["transcription"].configure(transcription_config)

            # Configure LLM worker
            if "llm" in self.workers:
                llm_config = self.config.get("llm", {})
                self.workers["llm"].configure(llm_config)

            # Configure listener worker
            if "listener" in self.workers:
                audio_config = self.config.get("audio", {})
                self.workers["listener"].configure(audio_config)

            self.logger.debug("Worker settings configured")

        except Exception as e:
            self.logger.exception(f"Failed to configure worker settings: {e}")

    def start_transcription(self, file_path: str,
    ) -> None:
        """Start transcription of a file.
        
        Args:
            file_path: Path to the file to transcribe
        """
        if self.is_transcribing:
            self.logger.warning("Transcription already in progress")
            return

        self.logger.info("Starting transcription: {file_path}")

        try:
            self.is_transcribing = True

            # Start transcription worker
            if "transcription" in self.workers:
                self.workers["transcription"].transcribe_file(file_path)
                self.worker_started.emit("transcription")

        except Exception as e:
            self.logger.exception(f"Failed to start transcription: {e}")
            self.is_transcribing = False
            self.worker_error.emit("transcription", str(e))

    def start_batch_transcription(self, file_paths: list,
    ) -> None:
        """Start batch transcription of multiple files.
        
        Args:
            file_paths: List of file paths to transcribe
        """
        if self.is_transcribing:
            self.logger.warning("Transcription already in progress")
            return

        self.logger.info("Starting batch transcription: {len(file_paths)} files")

        try:
            # Setup queue
            self.transcription_queue = file_paths.copy()
            self.total_files_count = len(file_paths)
            self.current_file_index = 0

            # Start processing
            self._process_next_file()

        except Exception as e:
            self.logger.exception(f"Failed to start batch transcription: {e}")
            self.worker_error.emit("transcription", str(e))

    def _process_next_file(self) -> None:
        """Process the next file in the transcription queue."""
        if not self.transcription_queue:
            self.logger.info("Batch transcription completed")
            self.is_transcribing = False
            self.transcription_completed.emit("", {"batch_complete": True})
            return

        # Update progress
        self.current_file_index += 1
        if self.total_files_count > 0:
            progress = int((self.current_file_index / self.total_files_count) * 100)
            self.transcription_progress.emit(progress)

        # Get next file
        next_file = self.transcription_queue.pop(0)

        # Start transcription
        self.start_transcription(next_file)

    def start_recording(self) -> None:
        """Start audio recording."""
        if self.is_recording:
            self.logger.warning("Recording already in progress")
            return

        self.logger.info("Starting audio recording")

        try:
            if "listener" in self.workers:
                self.workers["listener"].start_recording()
                self.worker_started.emit("listener")

        except Exception as e:
            self.logger.exception(f"Failed to start recording: {e}",
    )
            self.worker_error.emit("listener", str(e))

    def stop_recording(self) -> None:
        """Stop audio recording."""
        if not self.is_recording:
            self.logger.warning("Recording not in progress")
            return

        self.logger.info("Stopping audio recording")

        try:
            if "listener" in self.workers:
                self.workers["listener"].stop_recording()
                self.worker_stopped.emit("listener")

        except Exception as e:
            self.logger.exception(f"Failed to stop recording: {e}")
            self.worker_error.emit("listener", str(e))

    def process_with_llm(self, text: str, prompt: str = "") -> None:
        """Process text with LLM.
        
        Args:
            text: Text to process
            prompt: Optional prompt for processing
        """
        self.logger.info("Processing text with LLM",
    )

        try:
            if "llm" in self.workers:
                self.workers["llm"].process_text(text, prompt)
                self.worker_started.emit("llm")

        except Exception as e:
            self.logger.exception(f"Failed to process with LLM: {e}")
            self.worker_error.emit("llm", str(e))

    def _handle_transcription_completed(self, output_path: str, transcription: dict,
    ) -> None:
        """Handle transcription completion.
        
        Args:
            output_path: Path to the output file
            transcription: Transcription result
        """
        self.logger.info("Transcription completed: {output_path}")

        # Emit signal
        self.transcription_completed.emit(output_path, transcription)

        # Process next file if in batch mode
        if self.transcription_queue:
            QTimer.singleShot(100, self._process_next_file)
        else:
            self.is_transcribing = False
            self.worker_stopped.emit("transcription")

    def _handle_transcription_error(self, error_message: str,
    ) -> None:
        """Handle transcription error.
        
        Args:
            error_message: Error message
        """
        if self.logger:
            self.logger.error(f"Transcription error: {error_message}")

        # Emit signal
        self.worker_error.emit("transcription", error_message)

        # Continue with next file if in batch mode
        if self.transcription_queue:
            QTimer.singleShot(100, self._process_next_file)
        else:
            self.is_transcribing = False

    def _handle_transcription_progress(self, progress: int,
    ) -> None:
        """Handle transcription progress update.
        
        Args:
            progress: Progress percentage
        """
        self.transcription_progress.emit(progress)

    def _handle_llm_response(self, response: str,
    ) -> None:
        """Handle LLM response.
        
        Args:
            response: LLM response text
        """
        self.logger.info("LLM response received")
        self.llm_response_ready.emit(response)
        self.worker_stopped.emit("llm")

    def _handle_llm_error(self, error_message: str,
    ) -> None:
        """Handle LLM error.
        
        Args:
            error_message: Error message
        """
        if self.logger:
            self.logger.error(f"LLM error: {error_message}")
        self.worker_error.emit("llm", error_message)

    def _handle_llm_progress(self, progress: int,
    ) -> None:
        """Handle LLM progress update.
        
        Args:
            progress: Progress percentage
        """
        # LLM progress can be forwarded if needed

    def _handle_recording_started(self) -> None:
        """Handle recording started event."""
        self.logger.info("Recording started")
        self.is_recording = True
        self.recording_started.emit()

    def _handle_recording_stopped(self) -> None:
        """Handle recording stopped event."""
        self.logger.info("Recording stopped")
        self.is_recording = False
        self.recording_stopped.emit()

    def _handle_audio_data(self, audio_data: bytes,
    ) -> None:
        """Handle audio data from recording.
        
        Args:
            audio_data: Recorded audio data
        """
        self.logger.info("Audio data received from recording")

        # Start transcription of audio data
        if "transcription" in self.workers:
            self.workers["transcription"].transcribe_audio_data(audio_data)

    def _handle_listener_error(self, error_message: str,
    ) -> None:
        """Handle listener error.
        
        Args:
            error_message: Error message
        """
        if self.logger:
            self.logger.error(f"Listener error: {error_message}")
        self.is_recording = False
        self.worker_error.emit("listener", error_message)

    def _on_transcription_completed(self, output_path: str, transcription: dict,
    ) -> None:
        """Handle transcription completed signal.
        
        Args:
            output_path: Path to the output file
            transcription: Transcription result
        """
        if self.completion_callback:
            self.completion_callback(output_path, transcription)

    def _on_worker_error(self, worker_type: str, error_message: str,
    ) -> None:
        """Handle worker error signal.
        
        Args:
            worker_type: Type of worker that errored
            error_message: Error message
        """
        if self.error_callback:
            self.error_callback(worker_type, error_message)

    def set_progress_callback(self, callback: Callable,
    ) -> None:
        """Set progress callback.
        
        Args:
            callback: Progress callback function
        """
        self.progress_callback = callback

    def set_completion_callback(self, callback: Callable,
    ) -> None:
        """Set completion callback.
        
        Args:
            callback: Completion callback function
        """
        self.completion_callback = callback

    def set_error_callback(self, callback: Callable,
    ) -> None:
        """Set error callback.
        
        Args:
            callback: Error callback function
        """
        self.error_callback = callback

    def stop_all_workers(self) -> None:
        """Stop all workers."""
        self.logger.info("Stopping all workers")

        # Stop recording if active
        if self.is_recording:
            self.stop_recording()

        # Stop transcription if active
        if self.is_transcribing:
            self.is_transcribing = False
            self.transcription_queue.clear()

        # Stop all worker threads
        for thread in self.worker_threads.values():
            if thread.isRunning():
                thread.quit()
                thread.wait(1000)  # Wait up to 1 second
                if thread.isRunning():
                    thread.terminate()
                    thread.wait()
                self.logger.debug("Stopped {worker_type} worker thread")

    def get_worker_status(self) -> dict[str, bool]:
        """Get status of all workers.
        
        Returns:
            Dictionary of worker statuses
        """
        status = {}
        for worker_type, thread in self.worker_threads.items():
            status[worker_type] = thread.isRunning()

        status["is_transcribing"] = self.is_transcribing
        status["is_recording"] = self.is_recording

        return status

    def cleanup(self) -> None:
        """Cleanup worker integration resources."""
        self.logger.info("Cleaning up worker integration component")

        # Stop all workers
        self.stop_all_workers()

        # Clear references
        self.workers.clear()
        self.worker_threads.clear()
        self.transcription_queue.clear()

        # Reset state
        self.is_transcribing = False
        self.is_recording = False
        self.current_file_index = 0
        self.total_files_count = 0

        self.logger.debug("Worker integration component cleanup complete")