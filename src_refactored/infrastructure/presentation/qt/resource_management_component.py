import gc

from PyQt6.QtCore import QObject, QThread, pyqtSignal
from PyQt6.QtWidgets import QDialog

from logger import setup_logger


class ResourceManagementComponent(QObject):
    """
    Component responsible for managing application resources including:
    - Worker initialization and cleanup
    - Model lifecycle management
    - Memory management and garbage collection
    - Settings dialog lazy initialization
    - Thread management and cleanup
    """

    # Signals
    resource_initialized = pyqtSignal(str)  # resource_name
    resource_cleanup_completed = pyqtSignal(str)  # resource_name
    memory_cleanup_completed = pyqtSignal()
    error_occurred = pyqtSignal(str)  # error_message

    def __init__(self, parent=None):
        super().__init__(parent)
        self.logger = setup_logger()

        # Resource tracking
        self._workers = {}
        self._threads = {}
        self._models = {}
        self._dialogs = {}

        # State
        self._is_cleaning_up = False

    def initialize_vad_worker(self, vad_worker_class, vad_thread: QThread,
    ) -> bool:
        """
        Initialize VAD (Voice Activity Detection) worker.
        
        Args:
            vad_worker_class: The VAD worker class to instantiate
            vad_thread: The thread to move the worker to
            
        Returns:
            bool: True if initialization successful, False otherwise
        """
        try:
            if "vad_worker" not in self._workers:
                worker = vad_worker_class()
                worker.moveToThread(vad_thread)

                # Connect signals
                worker.initialized.connect(
                    lambda: self.resource_initialized.emit("VAD",
    ),
                )
                worker.error.connect(
                    lambda error: self.error_occurred.emit(f"VAD Error: {error}"),
                )

                # Store references
                self._workers["vad_worker"] = worker
                self._threads["vad_thread"] = vad_thread

                # Start worker
                vad_thread.started.connect(worker.run)
                vad_thread.start()

                self.logger.debug("VAD worker initialized successfully")
                return True
            self.logger.warning("VAD worker already initialized")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to initialize VAD worker: {e}")
            self.error_occurred.emit(f"Failed to initialize VAD worker: {e}")
            return False

    def initialize_model_worker(self, model_worker_class, model_thread: QThread,
                              model_name: str, quantization: str,
    ) -> bool:
        """
        Initialize model worker with proper cleanup of existing model.
        
        Args:
            model_worker_class: The model worker class to instantiate
            model_thread: The thread to move the worker to
            model_name: Name of the model to load
            quantization: Quantization setting for the model
            
        Returns:
            bool: True if initialization successful, False otherwise
        """
        try:
            # Clean up existing model worker if present
            if "model_worker" in self._workers:
                self._cleanup_model_worker()

            # Create new model worker
            worker = model_worker_class(model_name, quantization)
            worker.moveToThread(model_thread)

            # Connect signals
            worker.initialized.connect(
                lambda: self.resource_initialized.emit(f"Model: {model_name}"),
            )
            worker.error.connect(
                lambda error: self.error_occurred.emit(f"Model Error: {error}"),
            )

            # Store references
            self._workers["model_worker"] = worker
            self._threads["model_thread"] = model_thread
            self._models["current_model"] = {
                "name": model_name,
                "quantization": quantization,
                "worker": worker,
            }

            # Start worker
            model_thread.started.connect(worker.run)
            model_thread.start()

            self.logger.debug("Model worker initialized: {model_name} ({quantization})")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to initialize model worker: {e}")
            self.error_occurred.emit(f"Failed to initialize model worker: {e}")
            return False

    def initialize_listener_worker(self, listener_worker_class, listener_thread: QThread,
                                 model_worker, vad_worker, recording_key: str,
    ) -> bool:
        """
        Initialize listener worker for audio recording.
        
        Args:
            listener_worker_class: The listener worker class to instantiate
            listener_thread: The thread to move the worker to
            model_worker: The model worker instance
            vad_worker: The VAD worker instance
            recording_key: The hotkey for recording
            
        Returns:
            bool: True if initialization successful, False otherwise
        """
        try:
            # Clean up existing listener worker if present
            if "listener_worker" in self._workers:
                self._cleanup_listener_worker()

            # Verify dependencies
            if not (hasattr(model_worker, "model") and hasattr(vad_worker, "vad")):
                self.logger.warning("Model or VAD not ready for listener initialization")
                return False

            # Create new listener worker
            worker = listener_worker_class(model_worker.model, vad_worker.vad, recording_key)
            worker.moveToThread(listener_thread)

            # Connect signals
            worker.initialized.connect(
                lambda: self.resource_initialized.emit("Listener"),
            )
            worker.error.connect(
                lambda error: self.error_occurred.emit(f"Listener Error: {error}"),
            )

            # Store references
            self._workers["listener_worker"] = worker
            self._threads["listener_thread"] = listener_thread

            # Start worker
            listener_thread.started.connect(worker.run)
            listener_thread.start()

            self.logger.debug("Listener worker initialized successfully")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to initialize listener worker: {e}")
            self.error_occurred.emit(f"Failed to initialize listener worker: {e}")
            return False

    def initialize_llm_worker(self, llm_worker_class, llm_thread: QThread,
                            model_type: str, quantization: str,
    ) -> bool:
        """
        Initialize LLM worker for language model inference.
        
        Args:
            llm_worker_class: The LLM worker class to instantiate
            llm_thread: The thread to move the worker to
            model_type: Type of LLM model to load
            quantization: Quantization setting for the LLM
            
        Returns:
            bool: True if initialization successful, False otherwise
        """
        try:
            # Clean up existing LLM worker if present
            if "llm_worker" in self._workers:
                self._cleanup_llm_worker()

            # Create new LLM worker
            worker = llm_worker_class(model_type=model_type, quantization=quantization)
            worker.moveToThread(llm_thread)

            # Connect signals
            worker.initialized.connect(
                lambda: self.resource_initialized.emit(f"LLM: {model_type}"),
            )
            worker.error.connect(
                lambda error: self.error_occurred.emit(f"LLM Error: {error}"),
            )

            # Store references
            self._workers["llm_worker"] = worker
            self._threads["llm_thread"] = llm_thread

            # Start worker
            llm_thread.started.connect(worker.run)
            llm_thread.start()

            self.logger.debug("LLM worker initialized: {model_type} ({quantization})")
            return True

        except Exception as e:
            self.logger.exception(f"Failed to initialize LLM worker: {e}")
            self.error_occurred.emit(f"Failed to initialize LLM worker: {e}")
            return False

    def get_or_create_settings_dialog(self, dialog_class, **kwargs) -> QDialog | None:
        """
        Lazy initialization of settings dialog.
        
        Args:
            dialog_class: The dialog class to instantiate
            **kwargs: Arguments to pass to dialog constructor
            
        Returns:
            Optional[QDialog]: The dialog instance or None if creation failed
        """
        try:
            if "settings_dialog" not in self._dialogs or self._dialogs["settings_dialog"] is None:
                dialog = dialog_class(**kwargs)
                self._dialogs["settings_dialog"] = dialog
                self.logger.debug("Settings dialog created")

            return self._dialogs["settings_dialog"]

        except Exception as e:
            self.logger.exception(f"Failed to create settings dialog: {e}")
            self.error_occurred.emit(f"Failed to create settings dialog: {e}")
            return None

    def cleanup_all_resources(self) -> None:
        """
        Clean up all managed resources.
        """
        if self._is_cleaning_up:
            return

        self._is_cleaning_up = True
        self.logger.debug("Starting resource cleanup")

        try:
            # Clean up workers in reverse order of dependency
            self._cleanup_listener_worker()
            self._cleanup_llm_worker()
            self._cleanup_model_worker()
            self._cleanup_vad_worker()

            # Clean up dialogs
            self._cleanup_dialogs()

            # Force memory cleanup
            self.perform_memory_cleanup()

            self.logger.debug("Resource cleanup completed")

        except Exception as e:
            self.logger.exception(f"Error during resource cleanup: {e}")
        finally:
            self._is_cleaning_up = False

    def _cleanup_model_worker(self,
    ) -> None:
        """
        Clean up model worker and associated resources.
        """
        try:
            if "model_worker" in self._workers:
                worker = self._workers["model_worker"]

                # Clean up model-specific resources
                if hasattr(worker, "model"):
                    model = worker.model

                    # Clear model sessions if available
                    if hasattr(model, "clear_sessions"):
                        model.clear_sessions()

                    # Delete model attributes
                    for attr in ["encoder_session", "decoder_session", "tokenizer", "feature_extractor"]:
                        if hasattr(model, attr):
                            delattr(model, attr)

                # Clean up thread and worker
                if "model_thread" in self._threads:
                    thread = self._threads["model_thread"]
                    thread.quit()
                    thread.wait()
                    thread.deleteLater()
                    del self._threads["model_thread"]

                worker.deleteLater()
                del self._workers["model_worker"]

                # Clear model tracking
                if "current_model" in self._models:
                    del self._models["current_model"]

                self.resource_cleanup_completed.emit("Model")
                self.logger.debug("Model worker cleaned up")

        except Exception as e:
            self.logger.exception(f"Error cleaning up model worker: {e}")

    def _cleanup_listener_worker(self,
    ) -> None:
        """
        Clean up listener worker.
        """
        try:
            if "listener_worker" in self._workers:
                worker = self._workers["listener_worker"]

                # Stop listener
                if hasattr(worker, "stop"):
                    worker.stop()

                # Clean up thread
                if "listener_thread" in self._threads:
                    thread = self._threads["listener_thread"]
                    thread.quit()
                    thread.wait()
                    thread.deleteLater()
                    del self._threads["listener_thread"]

                worker.deleteLater()
                del self._workers["listener_worker"]

                self.resource_cleanup_completed.emit("Listener")
                self.logger.debug("Listener worker cleaned up")

        except Exception as e:
            self.logger.exception(f"Error cleaning up listener worker: {e}")

    def _cleanup_llm_worker(self) -> None:
        """
        Clean up LLM worker.
        """
        try:
            if "llm_worker" in self._workers:
                worker = self._workers["llm_worker"]

                # Clean up thread
                if "llm_thread" in self._threads:
                    thread = self._threads["llm_thread"]
                    if thread.isRunning():
                        thread.quit()
                        thread.wait()
                    thread.deleteLater()
                    del self._threads["llm_thread"]

                worker.deleteLater()
                del self._workers["llm_worker"]

                self.resource_cleanup_completed.emit("LLM")
                self.logger.debug("LLM worker cleaned up")

        except Exception as e:
            self.logger.exception(f"Error cleaning up LLM worker: {e}")

    def _cleanup_vad_worker(self) -> None:
        """
        Clean up VAD worker.
        """
        try:
            if "vad_worker" in self._workers:
                worker = self._workers["vad_worker"]

                # Clean up thread
                if "vad_thread" in self._threads:
                    thread = self._threads["vad_thread"]
                    thread.quit()
                    thread.wait()
                    thread.deleteLater()
                    del self._threads["vad_thread"]

                worker.deleteLater()
                del self._workers["vad_worker"]

                self.resource_cleanup_completed.emit("VAD")
                self.logger.debug("VAD worker cleaned up")

        except Exception as e:
            self.logger.exception(f"Error cleaning up VAD worker: {e}")

    def _cleanup_dialogs(self) -> None:
        """
        Clean up dialog resources.
        """
        try:
            for dialog in self._dialogs.values():
                if dialog is not None:
                    dialog.deleteLater()

            self._dialogs.clear()
            self.logger.debug("Dialogs cleaned up")

        except Exception as e:
            self.logger.exception(f"Error cleaning up dialogs: {e}")

    def perform_memory_cleanup(self) -> None:
        """
        Perform garbage collection and memory cleanup.
        """
        try:
            # Force garbage collection
            gc.collect()

            self.logger.debug("Garbage collection completed, collected {collected} objects")
            self.memory_cleanup_completed.emit()

        except Exception as e:
            self.logger.exception(f"Error during memory cleanup: {e}")

    def get_worker(self, worker_name: str,
    ):
        """
        Get a worker by name.
        
        Args:
            worker_name: Name of the worker to retrieve
            
        Returns:
            The worker instance or None if not found
        """
        return self._workers.get(worker_name)

    def get_thread(self, thread_name: str,
    ):
        """
        Get a thread by name.
        
        Args:
            thread_name: Name of the thread to retrieve
            
        Returns:
            The thread instance or None if not found
        """
        return self._threads.get(thread_name)

    def is_worker_initialized(self, worker_name: str,
    ) -> bool:
        """
        Check if a worker is initialized.
        
        Args:
            worker_name: Name of the worker to check
            
        Returns:
            bool: True if worker is initialized, False otherwise
        """
        return worker_name in self._workers and self._workers[worker_name] is not None

    def get_resource_status(self) -> dict:
        """
        Get status of all managed resources.
        
        Returns:
            dict: Status information for all resources
        """
        return {
            "workers": list(self._workers.keys()),
            "threads": list(self._threads.keys()),
            "models": list(self._models.keys()),
            "dialogs": list(self._dialogs.keys()),
            "is_cleaning_up": self._is_cleaning_up,
        }