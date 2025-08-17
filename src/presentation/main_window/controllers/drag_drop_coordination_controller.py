"""Drag Drop Coordination Controller.

This controller coordinates drag and drop functionality using proper DDD architecture,
delegating to use cases and domain services rather than implementing PyQt6 directly.
"""

from typing import Any

from PyQt6.QtCore import QObject, QThread, pyqtSignal
from PyQt6.QtWidgets import QWidget

from src.application.main_window_coordination import (
    MainWindowController,
)
from src.application.system_integration.process_drag_drop_use_case import (
    IDragDropProcessingPort,
    ProcessDragDropRequest,
    ProcessDragDropUseCase,
)
from src.domain.common.ports.logging_port import LoggingPort
from src.domain.system_integration.ports.drag_drop_port import IDragDropPort, MimeType
from src.domain.system_integration.value_objects.drag_drop_operations import DropZoneType
from src.presentation.main_window.controllers.ui_state_controller import (
    UIStateController,
)


class MainWindowDragDropProcessingAdapter(IDragDropProcessingPort):
    """Adapter that implements IDragDropProcessingPort for main window file processing."""
    
    def __init__(
        self, 
        main_window_controller: MainWindowController,
        ui_controller: UIStateController,
        logger: LoggingPort | None = None,
    ):
        self._main_window_controller = main_window_controller
        self._ui_controller = ui_controller
        self._logger = logger
        self._active_threads: list[QThread] = []
        self._active_workers: list[QObject] = []
    
    def process_dropped_files(self, file_paths: list[str]) -> bool:
        """Process dropped files off the UI thread and save output next to source file."""
        try:
            if not file_paths:
                return False
            
            # Find the first supported file
            target_file: str | None = None
            for candidate in file_paths:
                if self.validate_file_types([candidate]):
                    target_file = candidate
                    break

            if target_file is None:
                return False

            # Read output format from settings (default: SRT enabled)
            use_srt = True
            try:
                from src.infrastructure.adapters.configuration_adapter import ConfigurationServiceAdapter as _Cfg
                cfg = _Cfg()
                setting = cfg.get_value("output_srt", "True")
                use_srt = str(setting).strip().lower() in {"true", "1", "yes"}
            except Exception:
                use_srt = True

            # Start UI feedback
            self._ui_controller.start_transcribing_ui(show_progress=True)
            if self._logger:
                self._logger.log_info(f"Processing dropped file: {target_file}")

            # Background worker to avoid blocking UI
            class _TranscriptionWorker(QObject):
                finished = pyqtSignal(bool, str, str)  # success, saved_path, message
                progress = pyqtSignal(int, str)  # percent, message

                def __init__(self, file_path: str, save_as_srt: bool):
                    super().__init__()
                    self._file_path = file_path
                    self._save_as_srt = save_as_srt

                def run(self) -> None:
                    try:
                        from pathlib import Path as _Path
                        from src.infrastructure.adapters.transcription_adapter import (
                            SimpleTranscriptionAdapter as _SimpleTranscriptionAdapter,
                        )
                        from src.infrastructure.transcription.transcription_file_repository import (
                            TranscriptionFileRepository as _TranscriptionFileRepository,
                        )
                        from src.infrastructure.media.media_conversion_service import (
                            MediaConversionManager as _MediaConversionManager,
                        )
                        from src.infrastructure.media.media_info_service import (
                            MediaInfoService as _MediaInfo,
                        )
                        # No need for entity imports here; we build segment dicts directly

                        transcriber = _SimpleTranscriptionAdapter(None)
                        lower = self._file_path.lower()
                        video_exts = (".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv", ".webm", ".m4v")
                        self.progress.emit(10, "Preparing file...")
                        if lower.endswith(video_exts):
                            conv = _MediaConversionManager()
                            audio_tuple = conv.convert_video_to_audio(self._file_path)
                            if not audio_tuple:
                                self.finished.emit(False, "", "Video conversion failed")
                                return
                            _, audio_bytes, _ = audio_tuple
                            self.progress.emit(30, "Converting video to audio...")
                            text_result: str = transcriber.transcribe(audio_bytes)
                            # Estimate duration using pydub (safer for in-memory bytes)
                            try:
                                import io as _io
                                from pydub import AudioSegment as _AS
                                seg = _AS.from_file(_io.BytesIO(audio_bytes), format="wav")
                                duration_seconds = float(seg.duration_seconds)
                            except Exception:
                                duration_seconds = 30.0
                        else:
                            self.progress.emit(30, "Transcribing audio...")
                            text_result = transcriber.transcribe_audio(self._file_path)
                            try:
                                duration_seconds = _MediaInfo().get_duration_seconds(self._file_path, default=30.0)
                            except Exception:
                                duration_seconds = 30.0

                        parent_dir = str(_Path(self._file_path).parent)
                        repo = _TranscriptionFileRepository(base_path=parent_dir)
                        if self._save_as_srt:
                            # Use our internal timestamped segmentation (long-duration + VAD)
                            seg_dicts = None
                            try:
                                self.progress.emit(50, "Refining timestamps...")
                                # Prefer path input for efficiency
                                seg_dicts = transcriber.transcribe_with_timestamps(self._file_path)
                                if not seg_dicts:
                                    seg_dicts = None
                            except Exception:
                                seg_dicts = None

                            if seg_dicts is None:
                                # Fallback: split evenly by sentences across duration
                                import re as _re
                                sentences = _re.split(r"(?<=[.!?])\s+", text_result or "")
                                sentences = [s.strip() for s in sentences if s and s.strip()]
                                if not sentences:
                                    sentences = [text_result or ""]
                                seg_dur = max(0.5, duration_seconds / max(1, len(sentences)))
                                seg_dicts = []
                                for i, sentence in enumerate(sentences):
                                    start = i * seg_dur
                                    end = min(duration_seconds, (i + 1) * seg_dur)
                                    if end <= start:
                                        end = start + 0.5
                                    seg_dicts.append({"start": start, "end": end, "text": sentence})

                            self.progress.emit(80, "Saving SRT...")
                            saved_path = repo.save_transcription_segments(self._file_path, seg_dicts, output_format="srt")
                        else:
                            self.progress.emit(80, "Saving transcript...")
                            saved_path = repo.save_transcription_text(self._file_path, text_result, output_format="txt")
                        self.progress.emit(100, "Done")
                        self.finished.emit(True, saved_path, "")
                    except Exception as e:  # noqa: BLE001
                        self.finished.emit(False, "", str(e))

            worker = _TranscriptionWorker(target_file, use_srt)
            thread = QThread()
            worker.moveToThread(thread)
            thread.started.connect(worker.run)

            def _on_finished(success: bool, saved_path: str, message: str) -> None:
                try:
                    if success:
                        if self._logger:
                            self._logger.log_info(f"Saved transcription: {saved_path}")
                        self._main_window_controller.complete_transcription(
                            result=f"Saved: {saved_path}", transcription_type="file",
                        )
                    else:
                        if self._logger:
                            self._logger.log_error(f"Transcription failed: {message}")
                finally:
                    self._ui_controller.stop_transcribing_ui()
                    # Clean up and release references
                    thread.quit()
                    thread.wait(100)
                    worker.deleteLater()
                    thread.deleteLater()
                    try:
                        self._active_threads.remove(thread)
                    except ValueError:
                        pass
                    try:
                        self._active_workers.remove(worker)
                    except ValueError:
                        pass

            worker.finished.connect(_on_finished)
            worker.progress.connect(lambda p, _m: self._ui_controller.update_progress(max(0, min(100, int(p)))))
            self._active_threads.append(thread)
            self._active_workers.append(worker)
            thread.start()

            return True
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error processing dropped files: {e}")
            self._ui_controller.stop_transcribing_ui()
            return False
    
    def validate_file_types(self, file_paths: list[str]) -> list[str]:
        """Validate dropped file types."""
        supported_extensions = (".mp3", ".wav", ".mp4", ".avi", ".mov", ".m4a", ".flac")
        valid_files = []
        
        for file_path in file_paths:
            if file_path.lower().endswith(supported_extensions):
                valid_files.append(file_path)
        
        return valid_files


class DragDropCoordinationController:
    """Controller for coordinating drag and drop functionality using DDD architecture."""
    
    def __init__(
        self, 
        drag_drop_port: IDragDropPort,
        main_window_controller: MainWindowController,
        ui_controller: UIStateController,
        logger: LoggingPort | None = None,
    ):
        self._drag_drop_port = drag_drop_port
        self._main_window_controller = main_window_controller
        self._ui_controller = ui_controller
        self._logger = logger
        
        # Create processing adapter
        self._processing_adapter = MainWindowDragDropProcessingAdapter(
            main_window_controller, ui_controller, logger,
        )
        
        # Create use case
        self._process_drag_drop_use_case = ProcessDragDropUseCase(self._processing_adapter)
        
        # Zone configuration
        self._main_zone_id = "main_window"
    
    def setup_main_window_drag_drop(self, main_window: QWidget) -> bool:
        """Set up drag and drop for the main window using proper DDD architecture."""
        try:
            # Enable drag drop through port
            enable_result = self._drag_drop_port.enable_drag_drop(
                self._main_zone_id, 
                DropZoneType.MAIN_WINDOW,
            )
            
            if not enable_result.is_success:
                if self._logger:
                    self._logger.log_error(f"Failed to enable drag drop: {enable_result.get_error()}")
                return False
            
            # Set accepted MIME types for audio/video files
            mime_types = [
                MimeType.AUDIO_WAV,
                MimeType.AUDIO_MP3,
                MimeType.VIDEO_MP4,
            ]
            
            mime_result = self._drag_drop_port.set_accepted_mime_types(
                self._main_zone_id, 
                mime_types,
            )
            
            if not mime_result.is_success and self._logger:
                self._logger.log_warning(f"Failed to set MIME types: {mime_result.get_error()}")
            
            # Set drop callback
            def handle_drop(zone_id: str, files: list[str], metadata: dict[str, Any]):
                try:
                    if self._logger:
                        self._logger.log_info(f"Files dropped in zone {zone_id}: {files}")
                    
                    # Create request for use case
                    from src.domain.ui_coordination.value_objects.drag_drop_operations import (
                        DragDropEventData,
                    )
                    
                    event_data = DragDropEventData(
                        files=files,
                        position=metadata.get("position", (0, 0)),
                    )
                    
                    request = ProcessDragDropRequest(
                        event_data=event_data,
                        allowed_extensions=[".mp3", ".wav", ".mp4", ".avi", ".mov", ".m4a", ".flac"],
                        max_files=1,  # Process one file at a time
                        progress_callback=self._handle_progress,
                        completion_callback=self._handle_completion,
                        error_callback=self._handle_error,
                    )
                    
                    # Execute use case
                    response = self._process_drag_drop_use_case.execute(request)
                    
                    if response.success:
                        from src.domain.system_integration.ports.drag_drop_port import (
                            DropAction,
                        )
                        return DropAction.ACCEPT
                    if self._logger:
                        self._logger.log_warning(f"Drop processing failed: {response.message}")
                    return DropAction.REJECT
                        
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error handling drop: {e}")
                    from src.domain.system_integration.ports.drag_drop_port import (
                        DropAction,
                    )
                    return DropAction.REJECT
            
            drop_callback_result = self._drag_drop_port.set_drop_callback(
                self._main_zone_id,
                handle_drop,
            )
            
            if not drop_callback_result.is_success:
                if self._logger:
                    self._logger.log_error(f"Failed to set drop callback: {drop_callback_result.get_error()}")
                return False
            
            # Set drag enter callback for visual feedback
            def handle_drag_enter(zone_id: str, metadata: dict[str, Any]) -> bool:
                try:
                    # Show visual feedback through UI controller
                    # This could trigger status message or cursor change
                    if self._logger:
                        self._logger.log_debug(f"Drag entered zone {zone_id}")
                    return True
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error handling drag enter: {e}")
                    return False
            
            enter_callback_result = self._drag_drop_port.set_drag_enter_callback(
                self._main_zone_id,
                handle_drag_enter,
            )
            
            if not enter_callback_result.is_success:
                if self._logger:
                    self._logger.log_warning(f"Failed to set drag enter callback: {enter_callback_result.get_error()}")
            
            # Set drag leave callback
            def handle_drag_leave(zone_id: str) -> None:
                try:
                    if self._logger:
                        self._logger.log_debug(f"Drag left zone {zone_id}")
                    # Could reset visual feedback here
                except Exception as e:
                    if self._logger:
                        self._logger.log_error(f"Error handling drag leave: {e}")
            
            leave_callback_result = self._drag_drop_port.set_drag_leave_callback(
                self._main_zone_id,
                handle_drag_leave,
            )
            
            if not leave_callback_result.is_success:
                if self._logger:
                    self._logger.log_warning(f"Failed to set drag leave callback: {leave_callback_result.get_error()}")
            
            # Enable drag drop on the actual widget using the adapter's convenience method
            if hasattr(self._drag_drop_port, "enable_widget_drag_drop"):
                # Prefer enabling on the central widget to ensure events are delivered to the handled widget
                target_widget = getattr(main_window, "centralwidget", None) or main_window
                widget_result = self._drag_drop_port.enable_widget_drag_drop(
                    target_widget,
                    self._main_zone_id, 
                    media_files=True,
                )
                
                if not widget_result.is_success:
                    if self._logger:
                        self._logger.log_error(f"Failed to enable widget drag drop: {widget_result.error}")
                    return False
            
            if self._logger:
                self._logger.log_info("Main window drag drop setup completed using DDD architecture")
            
            return True
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error setting up main window drag drop: {e}")
            return False
    
    def _handle_progress(self, message: str, progress: float) -> None:
        """Handle progress updates from drag drop processing."""
        try:
            if self._logger:
                self._logger.log_debug(f"Drag drop progress: {message} ({progress:.1%})")
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error handling progress: {e}")
    
    def _handle_completion(self, processed_files: list[str]) -> None:
        """Handle completion of drag drop processing.

        No-op here because the background worker handles UI completion/state.
        """
        if self._logger:
            try:
                self._logger.log_debug("Drag drop use case signaled completion; handled by worker")
            except Exception:
                pass
    
    def _handle_error(self, error_message: str) -> None:
        """Handle errors from drag drop processing."""
        try:
            if self._logger:
                self._logger.log_error(f"Drag drop processing error: {error_message}")
            
            # Stop any ongoing UI operations
            self._ui_controller.stop_transcribing_ui()
            
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error handling error: {e}")
    
    def get_active_zones(self) -> list[str]:
        """Get list of active drop zones."""
        try:
            result = self._drag_drop_port.get_active_drop_zones()
            if result.is_success:
                return result.get_value()
            if self._logger:
                self._logger.log_error(f"Failed to get active zones: {result.get_error()}")
            return []
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error getting active zones: {e}")
            return []
    
    def validate_dropped_files(self, files: list[str]) -> list[str]:
        """Validate dropped files using the port."""
        try:
            result = self._drag_drop_port.validate_drop_data(self._main_zone_id, files)
            if result.is_success:
                return result.get_value()
            if self._logger:
                self._logger.log_warning(f"File validation failed: {result.get_error()}")
            return []
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error validating files: {e}")
            return []
    
    def cleanup(self) -> None:
        """Clean up drag drop resources."""
        try:
            self._drag_drop_port.disable_drag_drop(self._main_zone_id)
            
            if hasattr(self._drag_drop_port, "cleanup"):
                self._drag_drop_port.cleanup()
            
            if self._logger:
                self._logger.log_info("Drag drop coordination controller cleaned up")
                
        except Exception as e:
            if self._logger:
                self._logger.log_error(f"Error during drag drop cleanup: {e}")

