"""Worker Integration Orchestrator for refactored WinSTT application.

This module provides PyQt worker orchestration service that adapts to the new
DI container and follows the refactored DDD architecture.
"""

import gc
from dataclasses import dataclass
from typing import Any

from PyQt6.QtCore import QObject, QThread, QTimer, pyqtSignal

from src_refactored.domain.common.ports.logging_port import LoggingPort
from src_refactored.domain.common.ports.progress_notification_port import (
    IProgressNotificationService,
)
from src_refactored.domain.common.ports.ui_component_port import (
    IUIComponent,
    IUIEventHandler,
    UIEvent,
    UIEventType,
)
from src_refactored.domain.common.result import Result
from src_refactored.domain.worker_management.ports.worker_factory_port import IWorkerFactory


@dataclass
class WorkerStatus:
    """Status information for a worker."""
    worker_id: str
    worker_type: str
    is_running: bool
    is_initialized: bool
    thread_id: str | None = None
    error_message: str | None = None



class WorkerIntegrationOrchestrator(QObject, IUIComponent, IUIEventHandler):
    """Orchestrates PyQt workers and integrates them with the DI container.
    
    This class manages the lifecycle of background workers, handles their
    communication, and provides a unified interface for worker operations.
    """
    
    # Signals for worker events
    worker_initialized = pyqtSignal(str, str)  # worker_id, worker_type
    worker_error = pyqtSignal(str, str)  # worker_id, error_message
    worker_completed = pyqtSignal(str, str)  # worker_id, result
    transcription_ready = pyqtSignal(str)  # transcription_text
    recording_started = pyqtSignal()
    recording_stopped = pyqtSignal()
    model_download_progress = pyqtSignal(str, int)  # message, percentage
    llm_inference_complete = pyqtSignal(str)  # response_text
    
    def __init__(self, 
                 worker_factory: IWorkerFactory,
                 progress_service: IProgressNotificationService,
                 logger: LoggingPort):
        super().__init__()
        self.worker_factory = worker_factory
        self.progress_service = progress_service
        self.logger = logger
        
        # Worker management
        self.workers: dict[str, QObject] = {}
        self.threads: dict[str, QThread] = {}
        self.worker_status: dict[str, WorkerStatus] = {}
        
        # Cleanup timer
        self.cleanup_timer = QTimer()
        self.cleanup_timer.timeout.connect(self._periodic_cleanup)
        self.cleanup_timer.start(30000)  # Cleanup every 30 seconds
        
        # Worker counter for unique IDs
        self._worker_counter = 0
    
    def _generate_worker_id(self, worker_type: str) -> str:
        """Generate unique worker ID."""
        self._worker_counter += 1
        return f"{worker_type}_{self._worker_counter}"
    
    def create_vad_worker(self) -> Result[str]:
        """Create and start VAD worker."""
        try:
            worker_id = self._generate_worker_id("vad")
            worker = self.worker_factory.create_vad_worker()
            
            # Create thread
            thread = QThread()
            worker.moveToThread(thread)
            
            # Connect signals
            worker.initialized.connect(lambda: self._on_worker_initialized(worker_id, "vad"))
            worker.error.connect(lambda error: self._on_worker_error(worker_id, error))
            thread.started.connect(worker.run)
            
            # Store references
            self.workers[worker_id] = worker
            self.threads[worker_id] = thread
            self.worker_status[worker_id] = WorkerStatus(
                worker_id=worker_id,
                worker_type="vad",
                is_running=False,
                is_initialized=False,
                thread_id=str(thread.currentThreadId()),
            )
            
            # Start thread
            thread.start()
            self.worker_status[worker_id].is_running = True
            
            self.logger.info(f"VAD worker created with ID: {worker_id}")
            return Result.success(worker_id)
            
        except Exception as e:
            error_msg = f"Failed to create VAD worker: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def create_model_worker(self, model_type: str, quantization: str) -> Result[str]:
        """Create and start model worker."""
        try:
            worker_id = self._generate_worker_id("model")
            worker = self.worker_factory.create_model_worker(model_type, quantization)
            
            # Create thread
            thread = QThread()
            worker.moveToThread(thread)
            
            # Connect signals
            worker.initialized.connect(lambda: self._on_worker_initialized(worker_id, "model"))
            worker.error.connect(lambda error: self._on_worker_error(worker_id, error))
            worker.display_message_signal.connect(self._on_progress_update)
            thread.started.connect(worker.run)
            
            # Store references
            self.workers[worker_id] = worker
            self.threads[worker_id] = thread
            self.worker_status[worker_id] = WorkerStatus(
                worker_id=worker_id,
                worker_type="model",
                is_running=False,
                is_initialized=False,
                thread_id=str(thread.currentThreadId()),
            )
            
            # Start thread
            thread.start()
            self.worker_status[worker_id].is_running = True
            
            self.logger.info(f"Model worker created with ID: {worker_id} for model: {model_type}")
            return Result.success(worker_id)
            
        except Exception as e:
            error_msg = f"Failed to create model worker: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def create_listener_worker(self, model: Any, vad: Any, rec_key: str) -> Result[str]:
        """Create and start listener worker."""
        try:
            worker_id = self._generate_worker_id("listener")
            worker = self.worker_factory.create_listener_worker(model, vad, rec_key)
            
            # Create thread
            thread = QThread()
            worker.moveToThread(thread)
            
            # Connect signals
            worker.initialized.connect(lambda: self._on_worker_initialized(worker_id, "listener"))
            worker.error.connect(lambda error: self._on_worker_error(worker_id, error))
            worker.transcription_ready.connect(self.transcription_ready.emit)
            worker.recording_started.connect(self.recording_started.emit)
            worker.recording_stopped.connect(self.recording_stopped.emit)
            worker.display_message_signal.connect(self._on_progress_update)
            thread.started.connect(worker.run)
            
            # Store references
            self.workers[worker_id] = worker
            self.threads[worker_id] = thread
            self.worker_status[worker_id] = WorkerStatus(
                worker_id=worker_id,
                worker_type="listener",
                is_running=False,
                is_initialized=False,
                thread_id=str(thread.currentThreadId()),
            )
            
            # Start thread
            thread.start()
            self.worker_status[worker_id].is_running = True
            
            self.logger.info(f"Listener worker created with ID: {worker_id}")
            return Result.success(worker_id)
            
        except Exception as e:
            error_msg = f"Failed to create listener worker: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def create_llm_worker(self, model_type: str, quantization: str) -> Result[str]:
        """Create and start LLM worker."""
        try:
            worker_id = self._generate_worker_id("llm")
            worker = self.worker_factory.create_llm_worker(model_type, quantization)
            
            # Create thread
            thread = QThread()
            worker.moveToThread(thread)
            
            # Connect signals
            worker.initialized.connect(lambda: self._on_worker_initialized(worker_id, "llm"))
            worker.error.connect(lambda error: self._on_worker_error(worker_id, error))
            worker.inference_complete.connect(self.llm_inference_complete.emit)
            worker.display_message_signal.connect(self._on_progress_update)
            thread.started.connect(worker.run)
            
            # Store references
            self.workers[worker_id] = worker
            self.threads[worker_id] = thread
            self.worker_status[worker_id] = WorkerStatus(
                worker_id=worker_id,
                worker_type="llm",
                is_running=False,
                is_initialized=False,
                thread_id=str(thread.currentThreadId()),
            )
            
            # Start thread
            thread.start()
            self.worker_status[worker_id].is_running = True
            
            self.logger.info(f"LLM worker created with ID: {worker_id} for model: {model_type}")
            return Result.success(worker_id)
            
        except Exception as e:
            error_msg = f"Failed to create LLM worker: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def stop_worker(self, worker_id: str) -> Result[None]:
        """Stop a specific worker."""
        try:
            if worker_id not in self.workers:
                return Result.failure(f"Worker {worker_id} not found")
            
            worker = self.workers[worker_id]
            thread = self.threads[worker_id]
            
            # Stop worker if it has a stop method
            if hasattr(worker, "stop"):
                worker.stop()
            
            # Quit and wait for thread
            thread.quit()
            if not thread.wait(5000):  # Wait up to 5 seconds
                thread.terminate()
                thread.wait()
            
            # Update status
            if worker_id in self.worker_status:
                self.worker_status[worker_id].is_running = False
            
            self.logger.info(f"Worker {worker_id} stopped")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to stop worker {worker_id}: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def stop_all_workers(self) -> Result[None]:
        """Stop all workers."""
        try:
            worker_ids = list(self.workers.keys())
            for worker_id in worker_ids:
                self.stop_worker(worker_id)
            
            self.logger.info("All workers stopped")
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to stop all workers: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def get_worker_status(self, worker_id: str) -> WorkerStatus | None:
        """Get status of a specific worker."""
        return self.worker_status.get(worker_id)
    
    def get_all_worker_status(self) -> dict[str, WorkerStatus]:
        """Get status of all workers."""
        return self.worker_status.copy()
    
    def get_worker(self, worker_id: str) -> QObject | None:
        """Get worker instance by ID."""
        return self.workers.get(worker_id)
    
    def _on_worker_initialized(self, worker_id: str, worker_type: str) -> None:
        """Handle worker initialization."""
        if worker_id in self.worker_status:
            self.worker_status[worker_id].is_initialized = True
        
        self.worker_initialized.emit(worker_id, worker_type)
        self.logger.info(f"Worker {worker_id} ({worker_type}) initialized")
    
    def _on_worker_error(self, worker_id: str, error_message: str) -> None:
        """Handle worker error."""
        if worker_id in self.worker_status:
            self.worker_status[worker_id].error_message = error_message
        
        self.worker_error.emit(worker_id, error_message)
        self.progress_service.notify_error(f"Worker {worker_id}: {error_message}")
        self.logger.error(f"Worker {worker_id} error: {error_message}")
    
    def _on_progress_update(self, txt=None, filename=None, percentage=None, hold=False, reset=None) -> None:
        """Handle progress update from workers."""
        if txt:
            if percentage is not None:
                self.model_download_progress.emit(txt, percentage)
                self.progress_service.notify_progress(txt, percentage)
            else:
                self.progress_service.notify_progress(txt)
    
    def _periodic_cleanup(self) -> None:
        """Perform periodic cleanup of finished workers."""
        try:
            finished_workers = []
            
            for worker_id, thread in self.threads.items():
                if thread.isFinished():
                    finished_workers.append(worker_id)
            
            for worker_id in finished_workers:
                self._cleanup_worker(worker_id)
            
            # Force garbage collection
            gc.collect()
            
        except Exception as e:
            self.logger.exception(f"Error during periodic cleanup: {e}")
    
    def _cleanup_worker(self, worker_id: str) -> None:
        """Cleanup a finished worker."""
        try:
            if worker_id in self.workers:
                worker = self.workers[worker_id]
                if hasattr(worker, "deleteLater"):
                    worker.deleteLater()
                del self.workers[worker_id]
            
            if worker_id in self.threads:
                thread = self.threads[worker_id]
                if hasattr(thread, "deleteLater"):
                    thread.deleteLater()
                del self.threads[worker_id]
            
            if worker_id in self.worker_status:
                del self.worker_status[worker_id]
            
            self.logger.debug(f"Cleaned up worker {worker_id}")
            
        except Exception as e:
            self.logger.exception(f"Error cleaning up worker {worker_id}: {e}")
    
    def handle_event(self, event: UIEvent) -> Result[None]:
        """Handle UI events."""
        try:
            if event.event_type == UIEventType.WORKER_START_REQUESTED:
                worker_type = event.data.get("worker_type")
                if worker_type == "vad":
                    return self.create_vad_worker()
                if worker_type == "model":
                    model_type = event.data.get("model_type", "whisper-turbo")
                    quantization = event.data.get("quantization", "Full")
                    return self.create_model_worker(model_type, quantization)
                if worker_type == "listener":
                    model = event.data.get("model")
                    vad = event.data.get("vad")
                    rec_key = event.data.get("rec_key", "CTRL+ALT+A")
                    return self.create_listener_worker(model, vad, rec_key)
                if worker_type == "llm":
                    model_type = event.data.get("model_type", "gemma-3-1b-it")
                    quantization = event.data.get("quantization", "Full")
                    return self.create_llm_worker(model_type, quantization)
            
            elif event.event_type == UIEventType.WORKER_STOP_REQUESTED:
                worker_id = event.data.get("worker_id")
                if worker_id:
                    return self.stop_worker(worker_id)
                return self.stop_all_workers()
            
            return Result.success(None)
            
        except Exception as e:
            error_msg = f"Failed to handle event {event.event_type}: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def initialize(self) -> Result[None]:
        """Initialize the orchestrator."""
        try:
            self.logger.info("Worker integration orchestrator initialized")
            return Result.success(None)
        except Exception as e:
            error_msg = f"Failed to initialize worker orchestrator: {e}"
            self.logger.exception(error_msg)
            return Result.failure(error_msg)
    
    def cleanup(self) -> None:
        """Cleanup all resources."""
        try:
            self.cleanup_timer.stop()
            self.stop_all_workers()
            
            # Final cleanup
            for worker_id in list(self.workers.keys()):
                self._cleanup_worker(worker_id)
            
            gc.collect()
            self.logger.info("Worker integration orchestrator cleaned up")
            
        except Exception as e:
            self.logger.exception(f"Error during orchestrator cleanup: {e}")