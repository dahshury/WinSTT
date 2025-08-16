import gc
import io
import os
import subprocess
from threading import Thread

import numpy as np
from logger import setup_logger
from PyQt6 import QtCore, QtGui, QtWidgets
from PyQt6.QtCore import QEvent, QPropertyAnimation, Qt, QThread, QTimer
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QDialog,
    QFileDialog,
    QGraphicsOpacityEffect,
    QListView,
    QMainWindow,
    QSystemTrayIcon,
    QTreeView,
)

from src.core.utils import get_config, resource_path
from src.ui.settings_dialog import SettingsDialog
from src.ui.voice_visualizer import VoiceVisualizer

logger = setup_logger()

def __init__(self, *args, **kwargs):
    super().__init__(*args, **kwargs)
    # Initialize attributes
    self.transcription_queue = []
    self.is_transcribing = False
    self.config = get_config()
    
    # Override with values from config, if available
    self.selected_model = self.config.get("model", "whisper-turbo")
    self.selected_quantization = self.config.get("quantization", "Quantized")
    self.enable_recording_sound = self.config.get("recording_sound_enabled", True)
    self.start_sound = self.config.get("sound_file_path", self.start_sound)
    self.current_output_srt = self.config.get("output_srt", False)
    self.rec_key = self.config.get("recording_key", "CTRL+ALT+A")
    
    # Initialize LLM settings from config
    self.llm_enabled = self.config.get("llm_enabled", False)
    self.llm_model = self.config.get("llm_model", "gemma-3-1b-it")
    self.llm_quantization = self.config.get("llm_quantization", "Full")
    self.llm_prompt = self.config.get("llm_prompt", "You are a helpful assistant.")
    
    # We'll initialize the dialog lazily when needed in open_settings
    # to avoid circular dependencies
    self.dialog = None
    
    # Initialize LLM worker if enabled
    if self.llm_enabled:
        # Create the LLM thread if needed
        if not hasattr(self, "llm_thread"):
            self.llm_thread = QThread()
        # Initialize LLM worker after other workers
        QTimer.singleShot(3000, self.init_llm_worker)

def open_settings(self):
    """Open the settings dialog. Settings changes are applied immediately."""
    # Create the dialog if it doesn't exist or was deleted
    if not hasattr(self, "dialog") or self.dialog is None:
        from src.ui.settings_dialog import SettingsDialog
        self.dialog = SettingsDialog(
            self.selected_model,
            self.selected_quantization,
            self.enable_recording_sound,
            self.start_sound,
            self.current_output_srt,
            parent=self,
            llm_enabled=self.llm_enabled,
            llm_model=self.llm_model,
            llm_quantization=self.llm_quantization,
            llm_prompt=self.llm_prompt,
        )
    
    # Show the dialog - no need to check for accept/reject as changes are applied immediately
    self.dialog.exec()

def init_workers_and_signals(self):
    # Initialize VAD worker and thread
    if not hasattr(self, "vad_worker"):
        self.vad_worker = self.VadWorker()
        self.vad_worker.moveToThread(self.vad_thread)
        self.vad_worker.initialized.connect(lambda: self.display_message(txt="VAD Initialized"))
        self.vad_worker.error.connect(lambda error_message: self.display_message(txt=f"Error: {error_message}"))
        self.vad_thread.started.connect(self.vad_worker.run)
        self.vad_thread.start()

    # Initialize Model worker and thread
    if hasattr(self, "model_worker"):
        # Properly clean up the old model before creating a new one
        logger.debug(f"Cleaning up previous model worker and loading new model with quantization: {self.selected_quantization}")
        
        # Stop any active listener that might be using the model
        if hasattr(self, "listener_worker"):
            logger.debug("Stopping listener before model change")
            self.listener_worker.stop()
            self.listener_thread.quit()
            self.listener_thread.wait()
            self.listener_worker.deleteLater()
            self.listener_thread.deleteLater()
            self.listener_thread = QThread()
            self.started_listener = False
        
        # Clean up the model
        try:
            # Release memory used by the model
            if hasattr(self.model_worker, "model"):
                if hasattr(self.model_worker.model, "clear_sessions"):
                    logger.debug("Clearing model sessions")
                    self.model_worker.model.clear_sessions()
                
                logger.debug("Deleting model attributes")
                # Delete the model attributes explicitly
                if hasattr(self.model_worker.model, "encoder_session"):
                    del self.model_worker.model.encoder_session
                if hasattr(self.model_worker.model, "decoder_session"):
                    del self.model_worker.model.decoder_session
                if hasattr(self.model_worker.model, "tokenizer"):
                    del self.model_worker.model.tokenizer
                if hasattr(self.model_worker.model, "feature_extractor"):
                    del self.model_worker.model.feature_extractor
                
            # Stop thread and wait for it to finish
            self.model_thread.quit()
            self.model_thread.wait()
            
            # Delete the worker and thread
            self.model_worker.deleteLater()
            self.model_thread.deleteLater()
        except Exception as e:
            logger.exception(f"Error cleaning up model: {e!s}")
        
        # Force garbage collection
        gc.collect()
        
        # Create new thread
        self.model_thread = QThread()
    
    # Create new model worker with selected quantization
    self.model_worker = self.ModelWorker(self.selected_model, self.selected_quantization)
    self.model_worker.moveToThread(self.model_thread)
    
    # Create a safe display message handler that catches exceptions
    def safe_display_message(txt=None, filename=None, percentage=None, hold=False, reset=None):
        try:
            self.display_message(txt, filename, percentage, hold, reset)
        except RuntimeError as e:
            # If there's a runtime error (like object deleted), log it but don't crash
            logger.exception(f"Runtime error in display_message: {e!s}")
    
    # Connect signals with the safe handler
    self.model_worker.display_message_signal.connect(safe_display_message)
    self.model_worker.initialized.connect(lambda: (self.display_message(txt=f"Model Initialized: {self.selected_model}"), self.init_listener()))
    # self.model_worker.initialized.connect(lambda: self.init_listener())
    self.model_worker.error.connect(lambda error_message: self.display_message(txt=f"Error: {error_message}"))
    self.model_thread.started.connect(self.model_worker.run)
    self.model_thread.start()
    
    # Initialize voice visualizer
    if not hasattr(self, "voice_visualizer_controller"):
        self.voice_visualizer_controller = VoiceVisualizer(self)
        # Connect signals for recording state changes
        if hasattr(self, "listener_worker"):
            self.listener_worker.recording_started.connect(self.show_voice_visualizer)
            self.listener_worker.recording_stopped.connect(self.hide_voice_visualizer)
    
    # Add a fade-in animation for the instruction text after initialization
    QTimer.singleShot(1000, self.fade_in_instruction_text)
    
def init_listener(self):
    # Initialize Listener worker and thread
    if hasattr(self, "model_worker") and hasattr(self.model_worker, "model") and hasattr(self, "vad_worker") and hasattr(self.vad_worker, "vad"):
        if not self.started_listener:
            self.started_listener = True
        elif hasattr(self, "listener_worker"):
            self.listener_worker.stop()
            self.listener_thread.quit()
            self.listener_thread.wait()
            self.listener_worker.deleteLater()
            self.listener_thread.deleteLater()
            gc.collect()
            self.listener_thread = QThread()
        self.listener_worker = self.ListenerWorker(self.model_worker.model, self.vad_worker.vad, self.rec_key)
        self.listener_worker.moveToThread(self.listener_thread)
        self.listener_worker.transcription_ready.connect(self.handle_transcription)
        self.listener_worker.error.connect(lambda error_message: self.display_message(txt=f"Error: {error_message}"))
        self.listener_worker.initialized.connect(lambda: self.display_message(txt="Listener Initialized"))
        
        # Create a safe display message handler that catches exceptions
        def safe_display_message(txt=None, filename=None, percentage=None, hold=False, reset=None):
            try:
                self.display_message(txt, filename, percentage, hold, reset)
            except RuntimeError as e:
                # If there's a runtime error (like object deleted), log it but don't crash
                logger.exception(f"Runtime error in display_message: {e!s}")
        
        # Connect with the safe handler
        self.listener_worker.display_message_signal.connect(safe_display_message)
        
        # Add signals for recording state changes
        self.listener_worker.recording_started.connect(self.show_voice_visualizer)
        self.listener_worker.recording_stopped.connect(self.hide_voice_visualizer)
        self.listener_thread.started.connect(self.listener_worker.run)
        self.listener_thread.start()
        
        # Set initial start_sound based on enable_recording_sound
        if self.enable_recording_sound and hasattr(self.listener_worker, "listener"):
            self.listener_worker.listener.start_sound_file = self.start_sound
            self.listener_worker.listener.init_pygame()
        elif hasattr(self.listener_worker, "listener"):
            self.listener_worker.listener.start_sound_file = None
            self.listener_worker.listener.start_sound = None

def init_llm_worker(self):
    """Initialize the LLM worker for inference if enabled in settings."""
    # Check if settings for LLM are enabled
    if not hasattr(self, "dialog") or not self.dialog.is_llm_enabled():
        return
        
    # Import the worker class if not already available
    if not hasattr(self, "LLMWorker"):
        from src.workers import LLMWorker
        self.LLMWorker = LLMWorker
    
    # Initialize LLM worker thread if not already initialized
    if not hasattr(self, "llm_thread"):
        self.llm_thread = QThread()
    elif self.llm_thread.isRunning():
        # Stop the current thread and worker if running
        self.llm_thread.quit()
        self.llm_thread.wait()
        if hasattr(self, "llm_worker"):
            self.llm_worker.deleteLater()
        self.llm_thread.deleteLater()
        self.llm_thread = QThread()
    
    # Get settings from dialog
    llm_model = self.dialog.get_llm_model()
    llm_quantization = self.dialog.get_llm_quantization()
    
    # Create worker
    self.llm_worker = self.LLMWorker(model_type=llm_model, quantization=llm_quantization)
    self.llm_worker.moveToThread(self.llm_thread)
    
    # Create a safe display message handler
    def safe_display_message(txt=None, filename=None, percentage=None, hold=False, reset=None):
        try:
            # Show progress bar if percentage is provided
            if percentage is not None and hasattr(self, "progressBar") and self.progressBar is not None:
                if not self.progressBar.isVisible():
                    self.progressBar.setVisible(True)
                
                # Update progress bar value
                self.progressBar.setValue(int(percentage))
                
                # Set text to "Downloading: filename" if provided, otherwise use generic text
                if filename:
                    self.display_message(txt=f"Downloading: {filename}", hold=True)
            
            # If reset is True, hide the progress bar 
            if reset and hasattr(self, "progressBar") and self.progressBar is not None:
                self.progressBar.setVisible(False)
                self.progressBar.setValue(0)
            
            # Display generic message if provided
            if txt:
                self.display_message(txt=txt, hold=hold)
                
        except RuntimeError as e:
            logger.exception(f"Runtime error in LLM display_message: {e!s}")
    
    # Connect signals
    self.llm_worker.display_message_signal.connect(safe_display_message)
    self.llm_worker.initialized.connect(lambda: self.display_message(txt=f"LLM Model Initialized: {llm_model}"))
    self.llm_worker.inference_complete.connect(lambda response: self.display_message(txt=response))
    self.llm_worker.error.connect(self.handle_llm_error)
    
    # Start the worker
    self.llm_thread.started.connect(self.llm_worker.run)
    self.llm_thread.start()

def handle_llm_error(self, error_message):
    """Handle errors from the LLM worker."""
    self.display_message(txt=f"LLM Error: {error_message}")
    
    # Disable LLM in settings to prevent repeated errors
    if hasattr(self, "dialog") and self.dialog.is_llm_enabled():
        self.dialog.enable_llm_toggle.setChecked(False)
        self.dialog.llm_enabled_changed()
        
    # Clean up worker and thread if needed
    if hasattr(self, "llm_thread") and self.llm_thread.isRunning():
        self.llm_thread.quit()
        self.llm_thread.wait()
        if hasattr(self, "llm_worker"):
            self.llm_worker.deleteLater()
            del self.llm_worker

def handle_transcription(self, transcription):
    """Handle the transcription received from the listener worker"""
    # First display the transcription
    self.display_message(txt=f"{transcription}")
    
    # If LLM is enabled, process the transcription through LLM
    if hasattr(self, "dialog") and self.dialog.is_llm_enabled() and hasattr(self, "llm_worker") and self.llm_worker.status:
        # Only process non-empty transcriptions
        if transcription and transcription.strip():
            # Get the system prompt from settings
            system_prompt = self.dialog.get_llm_prompt()
            
            # Display message about processing with LLM
            self.display_message(txt="Processing with LLM...")
            
            # Generate response in a separate thread to avoid freezing the UI
            def generate_llm_response():
                try:
                    # Generate the response
                    response = self.llm_worker.generate_response(transcription, system_prompt)
                    
                    # Clean up the response - remove any special tokens or formatting artifacts
                    cleaned_response = response.strip()
                    
                    # Format the LLM response to clearly distinguish it from transcription
                    formatted_response = f"🤖 LLM Response: {cleaned_response}"
                    
                    # Emit the response
                    self.llm_worker.inference_complete.emit(formatted_response)
                except Exception as e:
                    logger.exception(f"Error generating LLM response: {e!s}")
                    self.llm_worker.error.emit(f"Error: {e!s}")
            
            # Start the response generation in a separate thread
            Thread(target=generate_llm_response).start()

def display_message(self, txt=None, filename=None, percentage=None, hold=False, reset=None):
    # Create opacity effects if they don't exist
    if not hasattr(self, "label_opacity_effect"):
        self.label_opacity_effect = QGraphicsOpacityEffect(self.label_3)
        self.label_3.setGraphicsEffect(self.label_opacity_effect)
    
    if not hasattr(self, "progress_opacity_effect") and hasattr(self, "progressBar") and self.progressBar is not None:
        try:
            self.progress_opacity_effect = QGraphicsOpacityEffect(self.progressBar)
            self.progressBar.setGraphicsEffect(self.progress_opacity_effect)
        except RuntimeError:
            # If the progress bar has been deleted, we can't set the effect
            pass

    # Handle text display
    if txt:
        # Reset opacity
        self.label_opacity_effect.setOpacity(1.0)
        self.label_3.setText(txt)
        # Create fade out animation
        self.fade_out = QtCore.QPropertyAnimation(self.label_opacity_effect, b"opacity")
        self.fade_out.setDuration(3000)  # 3 second animation
        self.fade_out.setStartValue(1.0)
        self.fade_out.setEndValue(0.0)
        self.fade_out.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
        
        # Only start fade out if not holding the message (for transcription)
        if not hold:
            # Start fade out after 5 seconds
            QTimer.singleShot(5000, self.fade_out.start)
        
        # Clear text after animation
        self.fade_out.finished.connect(lambda: self.label_3.setText(""))
        
    elif filename:
        self.label_3.setText(f"Downloading {filename}...")
        self.label_opacity_effect.setOpacity(1.0)
    
    # Handle button states
    if hold:
        pass
    
    if reset:
        # Check if the progress bar still exists before accessing it
        if hasattr(self, "progressBar") and self.progressBar is not None:
            try:
                # Block signals during reset to prevent recursive updates
                self.progressBar.blockSignals(True)
                
                # Create fade out animations for both elements
                self.fade_out_label = QtCore.QPropertyAnimation(self.label_opacity_effect, b"opacity")
                self.fade_out_label.setDuration(3000)
                self.fade_out_label.setStartValue(1.0)
                self.fade_out_label.setEndValue(0.0)
                
                if hasattr(self, "progress_opacity_effect"):
                    self.fade_out_progress = QtCore.QPropertyAnimation(self.progress_opacity_effect, b"opacity")
                    self.fade_out_progress.setDuration(3000)
                    self.fade_out_progress.setStartValue(1.0)
                    self.fade_out_progress.setEndValue(0.0)
                
                    # Create animation group to run both animations together
                    self.animation_group = QtCore.QParallelAnimationGroup()
                    self.animation_group.addAnimation(self.fade_out_label)
                    self.animation_group.addAnimation(self.fade_out_progress)
                    
                    def cleanup():
                        try:
                            # Reset progress bar and hide it
                            if hasattr(self, "progressBar") and self.progressBar is not None:
                                self.progressBar.setValue(0)
                                self.progressBar.setVisible(False)
                            
                            # Reset label
                            self.label_3.setText("")
                            
                            # Reset opacity
                            self.label_opacity_effect.setOpacity(1.0)
                            if hasattr(self, "progress_opacity_effect") and self.progress_opacity_effect is not None:
                                self.progress_opacity_effect.setOpacity(1.0)
                            
                            # Unblock signals
                            if hasattr(self, "progressBar") and self.progressBar is not None:
                                self.progressBar.blockSignals(False)
                        except RuntimeError:
                            # If the QProgressBar has been deleted, we can simply pass
                            pass
                    
                    self.animation_group.finished.connect(cleanup)
                    self.animation_group.start()
                else:
                    # Only animate the label if progress effect doesn't exist
                    self.fade_out_label.start()
            except RuntimeError:
                # If the QProgressBar has been deleted, we can simply pass
                pass
    
    if percentage is not None:
        if self.settingsButton.isEnabled():
            self.settingsButton.setEnabled(False)
            self.is_downloading_model = True
            self.update_instruction_label()  # Hide instruction when download starts
        if percentage >= 100:
            self.settingsButton.setEnabled(True)
            self.is_downloading_model = False
            self.update_instruction_label()  # Show instruction when download completes
            
        # Check if the progress bar still exists before accessing it
        if hasattr(self, "progressBar") and self.progressBar is not None:
            try:
                # Block signals during value change
                self.progressBar.blockSignals(True)
                
                if not self.progressBar.isVisible():
                    self.progressBar.setVisible(True)
                    if hasattr(self, "progress_opacity_effect"):
                        self.progress_opacity_effect.setOpacity(1.0)
                
                self.progressBar.setProperty("value", percentage)
                
                # Unblock signals after update
                self.progressBar.blockSignals(False)
                
                # # Handle completion of transcription process - don't fade if we're in batch transcription
                # if percentage >= 100 and not hasattr(self, 'transcription_queue') or (hasattr(self, 'transcription_queue') and not self.transcription_queue):
                #     # Use a timer to delay the reset to avoid recursive updates
                #     QTimer.singleShot(1000, lambda: self.display_message(reset=True))
            except RuntimeError:
                # If the QProgressBar has been deleted, we can simply pass
                pass

def create_tray_icon(self):
    # Get icon path with robust path resolution
    icon_path = resource_path("resources/Windows 1 Theta.png")
    
    # Set the tray icon with the resolved path
    self.tray_icon.setIcon(QIcon(icon_path))

    self.show_action.triggered.connect(self.show_window)
    tray_menu = QtWidgets.QMenu()
    tray_menu.addAction(self.settings_action)
    tray_menu.addAction(self.close_action)
    
    self.tray_icon.setContextMenu(tray_menu)
    self.tray_icon.setVisible(True)
    self.tray_icon.show()
    self.tray_icon.activated.connect(self.tray_icon_activated)
    
def show_window(self):
    self.showNormal()
    self.activateWindow()
    
def close_app(self):
    self.tray_icon.hide()
    QApplication.quit()
    
def tray_icon_activated(self, reason):
    if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
        self.show_window()
        
def open_files(self):
    """Open file dialog to select audio files, video files, or folders for transcription."""
    file_dialog = QFileDialog(self)
    
    # Allow selecting files and directories
    file_dialog.setFileMode(QFileDialog.FileMode.ExistingFiles)
    file_dialog.setOption(QFileDialog.Option.DontUseNativeDialog, True)
    
    # Access the internal list view
    list_view = file_dialog.findChild(QListView, "listView")
    if list_view:
        list_view.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
    
    # Access the internal tree view
    tree_view = file_dialog.findChild(QTreeView)
    if tree_view:
        tree_view.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
    
    # Set filter for audio and video files
    file_dialog.setNameFilter("Media files (*.mp3 *.wav *.mp4 *.avi *.mkv *.mov *.flv *.wmv);;Audio files (*.mp3 *.wav);;Video files (*.mp4 *.avi *.mkv *.mov *.flv *.wmv);;All files (*.*)")
    
    if file_dialog.exec() == QDialog.DialogCode.Accepted:
        selected_files = file_dialog.selectedFiles()
        
        if not selected_files:
            return
            
        # Process the selected files and directories
        media_files = []
        
        for path in selected_files:
            if os.path.isdir(path):
                # Scan directory for media files
                self.display_message(txt=f"Scanning folder: {os.path.basename(path)}...", hold=True)
                folder_files = self.scan_folder_for_media(path)
                if folder_files:
                    media_files.extend(folder_files)
                    self.display_message(txt=f"Found {len(folder_files)} media files in folder", hold=True)
                else:
                    self.display_message(txt=f"No supported media files found in {os.path.basename(path)}", hold=True)
            elif self.is_supported_media_file(path):
                media_files.append(path)
        
        if media_files:
            self.process_media_files(media_files)
        else:
            self.display_message(txt="No valid media files selected", hold=True)

def get_key_name(self, event: QtGui.QKeyEvent):
    """Return the name of the key."""
    key = event.key()
    
    # Handle modifier keys
    if key == Qt.Key.Key_Control:
        return "Ctrl"
    if key == Qt.Key.Key_Alt:
        return "Alt"
    if key == Qt.Key.Key_Shift:
        return "Shift"
    if key == Qt.Key.Key_Meta:
        return "Meta"
    # Handle regular keys using key()
    key_text = QtGui.QKeySequence(key).toString()
    if key_text:
        return key_text
    return f"Key_{key}"

def eventFilter(self, obj, event):
    """Handle mouse clicks and hover events."""
    # Simplified event filter that no longer relies on toolbar functionality
    return QMainWindow.eventFilter(self, obj, event)

def keyPressEvent(self, event):
    # Use QMainWindow's keyPressEvent
    QMainWindow.keyPressEvent(self, event)

def keyReleaseEvent(self, event):
    # Use QMainWindow's keyReleaseEvent
    QMainWindow.keyReleaseEvent(self, event)

def showEvent(self, event):
    """Handle the first time the window is shown to initialize workers."""
    # Call the parent class's showEvent method first
    QMainWindow.showEvent(self, event)
    
    # Initialize workers only once when window is first shown
    if not hasattr(self, "_workers_initialized"):
        self._workers_initialized = True
        logger.info("Window shown for first time, initializing workers...")
        # Use a timer to initialize workers after the window is fully shown
        QTimer.singleShot(100, self.init_workers_and_signals)

def changeEvent(self, event):
    if event.type() == QEvent.Type.WindowStateChange:
        if self.windowState() == Qt.WindowState.WindowMinimized:
            self.minimize_counter+=1
            # Hide the window and remove from taskbar
            self.hide()
            # Show a tray notification
            if self.minimize_counter ==1:
                self.tray_icon.showMessage(
                    "App Minimized",
                    "The app is minimized to the system tray and running in the background. Right-click the tray icon to restore or exit.",
                    QSystemTrayIcon.MessageIcon.Information,
                    3000,
                )
        elif event.oldState() & Qt.WindowState.WindowMinimized:
            # Restore the window and show it in the taskbar
            self.show()
    # Use QMainWindow's changeEvent instead of super().changeEvent
    QMainWindow.changeEvent(self, event)

def resizeEvent(self, event):
    """Handle window resizing to maintain widget positions."""
    # Use QMainWindow's resizeEvent
    QMainWindow.resizeEvent(self, event)
    
    # No need to adjust toolbar or central widget positioning
    # since toolbar has been removed
    
    # Set central widget to cover the entire window
    self.centralwidget.setGeometry(0, 0, self.width(), self.height())

def dragEnterEvent(self, event):
    mime_data = event.mimeData()
    if mime_data.hasUrls():
        for url in mime_data.urls():
            file_path = url.toLocalFile()
            
            # Check if it's a directory
            if os.path.isdir(file_path):
                # Show drop indicator
                self.setCursor(Qt.CursorShape.DragCopyCursor)
                # Show message to indicate folder is droppable
                self.display_message(txt="Drop to transcribe all audio & video files in folder", hold=True)
                event.acceptProposedAction()
                return
                
            # Check if it's an audio file
            if file_path.lower().endswith((".mp3", ".wav")):
                # Show drop indicator
                self.setCursor(Qt.CursorShape.DragCopyCursor)
                # Show message to indicate file is droppable
                self.display_message(txt="Drop to transcribe", hold=True)
                event.acceptProposedAction()
                return
                
            # Check if it's a video file
            if file_path.lower().endswith((".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv")):
                # Show drop indicator
                self.setCursor(Qt.CursorShape.DragCopyCursor)
                # Show message to indicate conversion will be needed
                self.display_message(txt="Drop to convert and transcribe video", hold=True)
                event.acceptProposedAction()
                return
                
    event.ignore()
    
def dragLeaveEvent(self, event):
    # Reset cursor and message when drag leaves
    self.setCursor(Qt.CursorShape.ArrowCursor)
    self.display_message(reset=True)
    event.accept()

def dropEvent(self, event):
    """Handle drop events for files and folders."""
    # Reset the cursor
    self.setCursor(QtCore.Qt.CursorShape.ArrowCursor)
    self.display_message(txt="Processing dropped items...", hold=True)
    
    # Check if the data has URLs (files or directories)
    if event.mimeData().hasUrls():
        urls = event.mimeData().urls()
        paths = [url.toLocalFile() for url in urls]
        
        # Check if this is from SettingsDialog for sound file
        source_widget = event.source()
        if isinstance(source_widget, QtWidgets.QWidget) and source_widget.parent() and isinstance(source_widget.parent(), SettingsDialog):
            # Handle setting sound file
            if paths:
                path = paths[0]
                if os.path.isfile(path) and path.lower().endswith((".wav", ".mp3")):
                    source_widget.parent().set_sound_file(path)
                    event.accept()
                    return
        
        # Process files and directories for transcription
        media_files = []
        
        for path in paths:
            if os.path.isdir(path):
                # Scan directory for media files
                self.display_message(txt=f"Scanning folder: {os.path.basename(path)}...", hold=True)
                folder_files = self.scan_folder_for_media(path)
                if folder_files:
                    media_files.extend(folder_files)
                    self.display_message(txt=f"Found {len(folder_files)} media files in folder", hold=True)
                else:
                    self.display_message(txt=f"No supported media files found in {os.path.basename(path)}", hold=True)
            elif self.is_supported_media_file(path):
                media_files.append(path)
        
        if media_files:
            self.process_media_files(media_files)
            event.accept()
        else:
            self.display_message(txt="No valid media files found in dropped items", hold=True)
            event.ignore()
    else:
        event.ignore()

def is_supported_media_file(self, file_path):
    """Check if the file is a supported media type (audio or video)."""
    return self.is_audio_file(file_path) or self.is_video_file(file_path)

def is_audio_file(self, file_path):
    """Check if the file is an audio file."""
    ext = os.path.splitext(file_path)[1].lower()
    return ext in [".mp3", ".wav"]

def is_video_file(self, file_path):
    """Check if the file is a video file."""
    ext = os.path.splitext(file_path)[1].lower()
    return ext in [".mp4", ".avi", ".mkv", ".mov", ".flv", ".wmv"]

def scan_folder_for_media(self, folder_path):
    """Recursively scan a folder for media files."""
    media_files = []
    
    for root, _, files in os.walk(folder_path):
        for file in files:
            file_path = os.path.join(root, file)
            if self.is_supported_media_file(file_path):
                media_files.append(file_path)
    
    return media_files

def process_media_files(self, media_files):
    """Process a list of media files, converting videos if necessary and adding to transcription queue."""
    # Store total number of files for progress tracking
    if not media_files:
        self.display_message(txt="No valid files to transcribe", hold=True)
        return
        
    # Initialize progress tracking variables
    self.total_files_count = max(1, len(media_files))  # Ensure at least 1 to avoid division by zero
    self.current_file_index = 0
    
    # Initialize the transcription queue if it doesn't exist
    if not hasattr(self, "transcription_queue"):
        self.transcription_queue = []
    
    # Add files to the queue
    for file_path in media_files:
        if self.is_audio_file(file_path):
            # For audio files, add directly to transcription queue
            self.transcription_queue.append(file_path)
        elif self.is_video_file(file_path):
            # For video files, convert to audio in memory and add to queue
            self.display_message(txt=f"Converting video: {os.path.basename(file_path)}", hold=True)
            # Just add the video path to the queue with a marker
            # The actual conversion will happen when this item is processed
            self.transcription_queue.append(("video", file_path))
    
    if self.transcription_queue:
        self.display_message(txt=f"Added {len(media_files)} files to queue. Starting transcription...", hold=True)
        # Start processing the next file if not already in progress
        if not hasattr(self, "is_transcribing") or not self.is_transcribing:
            self.is_transcribing = False  # Initialize if it doesn't exist
            # Make progress bar visible
            if hasattr(self, "progressBar"):
                self.progressBar.setVisible(True)
                self.progressBar.setProperty("value", 0)
            self.process_next_file()
    else:
        self.display_message(txt="No valid files to transcribe", hold=True)

def convert_video_to_mp3(self, video_path):
    """Convert a video file to audio bytes in memory using ffmpeg."""
    try:
        base_name = os.path.basename(video_path)
        self.display_message(txt=f"Converting {base_name} to audio...", hold=True)
        
        # Use ffmpeg to extract audio and output to stdout as WAV format
        # -f wav specifies WAV format for stdout
        # -loglevel error reduces output noise
        ffmpeg_cmd = ["ffmpeg", "-i", video_path, "-f", "wav", "-ar", "16000", "-ac", "1", "-loglevel", "error", "pipe:1"]
        
        # Run ffmpeg process
        process = subprocess.Popen(
            ffmpeg_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=10**8,  # Use a large buffer size for the audio data
        )
        
        # Get output
        audio_bytes, stderr = process.communicate()
        
        # Check if conversion was successful
        if process.returncode == 0 and audio_bytes:
            self.display_message(txt=f"Conversion successful: {base_name}", hold=True)
            # Return a tuple with the original filename and audio bytes
            return ("memory_audio", audio_bytes, os.path.splitext(video_path)[0])
        error = stderr.decode("utf-8", errors="replace") if stderr else "Unknown error"
        self.display_message(txt=f"Conversion failed: {error}", hold=True)
        return None
            
    except Exception as e:
        self.display_message(txt=f"Error converting video: {e!s}", hold=True)
        return None

def process_next_file(self):
    """Process the next file in the transcription queue."""
    if not self.transcription_queue:
        self.display_message(txt="Transcription complete!")
        self.is_transcribing = False
        # Set a flag to hide progress bar later rather than immediately
        self.hide_progress_on_next_idle = True
        return
    
    # Update progress - safely handle division
    self.current_file_index += 1
    
    # Avoid division by zero and ensure we have a valid total count
    if hasattr(self, "total_files_count") and self.total_files_count > 0:
        progress_percentage = min(100, int((self.current_file_index / self.total_files_count) * 100))
    else:
        # Default to indeterminate progress if total count is missing or zero
        self.total_files_count = len(self.transcription_queue) + 1  # +1 for current file
        progress_percentage = min(100, int((1 / self.total_files_count) * 100))
    
    # Get the next file from the queue
    next_file = self.transcription_queue.pop(0)
    
    if isinstance(next_file, tuple) and len(next_file) >= 2:
        if next_file[0] == "video":
            # This is a video file that needs conversion
            video_path = next_file[1]
            self.display_message(txt=f"Converting video: {os.path.basename(video_path)}", hold=True)
            audio_data = self.convert_video_to_mp3(video_path)
            
            if audio_data:
                # Process the audio data immediately
                self.is_transcribing = True
                
                # Store progress info for later update rather than updating UI directly
                self.pending_progress = progress_percentage
                
                # Calculate file count for display - ensure we have valid values
                file_count_text = ""
                if hasattr(self, "current_file_index") and hasattr(self, "total_files_count"):
                    if self.current_file_index > 0 and self.total_files_count > 0:
                        file_count_text = f" ({self.current_file_index}/{self.total_files_count})"
                
                # Set the message with progress indicator
                f"Transcribing: {os.path.basename(video_path)}{file_count_text}"
                
                # # Use a timer to safely update UI after current UI event is processed
                # QTimer.singleShot(0, lambda: self.update_progress_safely(progress_text, self.pending_progress))
                
                # Start transcription in a separate thread
                transcription_thread = Thread(
                    target=self.transcribe_audio_data,
                    args=(audio_data,),
                    daemon=True,
                )
                transcription_thread.start()
            else:
                self.display_message(txt=f"Failed to convert video: {os.path.basename(video_path)}", hold=True)
                # Continue with the next file
                self.process_next_file()
        elif next_file[0] == "memory_audio":
            # This is already converted audio data in memory
            audio_data = next_file
            self.is_transcribing = True
            
            # Store progress info for later update rather than updating UI directly
            self.pending_progress = progress_percentage
            
            # Calculate file count for display
            file_count_text = ""
            if hasattr(self, "current_file_index") and hasattr(self, "total_files_count"):
                if self.current_file_index > 0 and self.total_files_count > 0:
                    file_count_text = f" ({self.current_file_index}/{self.total_files_count})"
            
            # Extract base name from the output path
            output_path = next_file[2] if len(next_file) > 2 else "audio"
            os.path.basename(output_path)
            
            # Set the message with progress indicator
            
            # Use a timer to safely update UI after current UI event is processed
            # QTimer.singleShot(0, lambda: self.update_progress_safely(progress_text, self.pending_progress))
            
            # Start transcription in a separate thread
            transcription_thread = Thread(
                target=self.transcribe_audio_data,
                args=(audio_data,),
                daemon=True,
            )
            transcription_thread.start()
    else:
        # This is an audio file path, transcribe it
        file_path = next_file
        self.is_transcribing = True
        
        # Store progress info for later update rather than updating UI directly
        self.pending_progress = progress_percentage
        
        # Calculate file count for display - ensure we have valid values
        file_count_text = ""
        if hasattr(self, "current_file_index") and hasattr(self, "total_files_count"):
            if self.current_file_index > 0 and self.total_files_count > 0:
                file_count_text = f" ({self.current_file_index}/{self.total_files_count})"
        
        # Set the message with progress indicator
        f"Transcribing: {os.path.basename(file_path)}{file_count_text}"
        
        # # Use a timer to safely update UI after current UI event is processed
        # QTimer.singleShot(0, lambda: self.update_progress_safely(progress_text, self.pending_progress))
        
        # Start transcription in a separate thread
        transcription_thread = Thread(
            target=self.transcribe_file,
            args=(file_path,),
            daemon=True,
        )
        transcription_thread.start()

def update_progress_safely(self, message_text, progress_value):
    """Update progress bar and message text safely to avoid recursive repaint."""
    if hasattr(self, "progressBar") and not self.progressBar.isVisible():
        self.progressBar.setVisible(True)
    
    # Update progress bar value without animation
    if hasattr(self, "progressBar"):
        self.progressBar.blockSignals(True)
        self.progressBar.setProperty("value", progress_value)
        self.progressBar.blockSignals(False)
    
    # Display message without triggering further updates
    if message_text:
        self.display_message(txt=message_text, hold=True)

def format_time_srt(self, time_seconds):
    """Format time in seconds to SRT format: HH:MM:SS,mmm."""
    hours = int(time_seconds // 3600)
    minutes = int((time_seconds % 3600) // 60)
    seconds = int(time_seconds % 60)
    milliseconds = int((time_seconds - int(time_seconds)) * 1000)
    
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"

def transcribe_file(self, file_path):
    """Transcribe an audio file."""
    try:
        # Display message already handled in process_next_file
        
        # Get output format preference - use a default if config doesn't exist
        if not hasattr(self, "config"):
            self.config = {"output_format": "srt"}
            logger.warning("Config not found, using default output format: srt")
        
        output_format = self.config.get("output_format", "srt")
        
        # Get the transcript from the model
        transcript = self.model_worker.transcript_file(file_path)
        
        # Calculate file count for display - ensure we have valid values
        file_count_text = ""
        if hasattr(self, "current_file_index") and hasattr(self, "total_files_count"):
            if self.current_file_index > 0 and self.total_files_count > 0:
                file_count_text = f" ({self.current_file_index}/{self.total_files_count})"
        
        if not transcript:
            self.display_message(txt=f"Transcription failed for: {os.path.basename(file_path)}{file_count_text}")
            # Continue with the next file - use a direct call instead of invokeMethod
            self.process_next_file()
            return
            
        # Determine output path
        output_path = os.path.splitext(file_path)[0]
        
        # Save as TXT or SRT based on config
        if output_format == "txt":
            # Save as TXT
            with open(f"{output_path}.txt", "w", encoding="utf-8") as f:
                f.write(transcript["text"])
            success_message = f"Saved transcript to: {os.path.basename(output_path)}.txt{file_count_text}"
            self.display_message(txt=success_message, hold=True)
        else:
            # Save as SRT
            with open(f"{output_path}.srt", "w", encoding="utf-8") as f:
                for i, segment in enumerate(transcript["segments"]):
                    start_time = self.format_time_srt(segment["start"])
                    end_time = self.format_time_srt(segment["end"])
                    text = segment["text"].strip()
                    
                    f.write(f"{i+1}\n")
                    f.write(f"{start_time} --> {end_time}\n")
                    f.write(f"{text}\n\n")
            success_message = f"Saved transcript to: {os.path.basename(output_path)}.srt{file_count_text}"
            self.display_message(txt=success_message, hold=True)
        
        # Process next file - use a direct call instead of invokeMethod
        self.process_next_file()
        
    except Exception as e:
        # Calculate file count for display - ensure we have valid values
        file_count_text = ""
        if hasattr(self, "current_file_index") and hasattr(self, "total_files_count"):
            if self.current_file_index > 0 and self.total_files_count > 0:
                file_count_text = f" ({self.current_file_index}/{self.total_files_count})"
                
        logger.exception(f"Error transcribing file {file_path}: {e!s}")
        error_message = f"Error transcribing file: {e!s}{file_count_text}"
        self.display_message(txt=error_message)
        # Process next file - use a direct call instead of invokeMethod
        self.process_next_file()

def transcription_finished(self, output_path, transcription, segments, is_temp=False, temp_path=None):
    """Called when transcription is complete."""
    try:
        # Log success
        logger.debug(f"Transcription finished successfully: {output_path}")
        
        # Determine message to display
        if self.current_output_srt and segments:
            message = f"Transcription complete. Saved to {os.path.basename(output_path)}"
        else:
            message = f"Transcription complete. Saved to {os.path.basename(output_path)}"
        
        # Show completion message
        self.display_message(txt=message, reset=True)
        
        # Clean up temp file if this is a video conversion
        if is_temp and temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
                logger.debug(f"Removed temporary file: {temp_path}")
            except Exception as e:
                logger.exception(f"Error removing temporary file: {e!s}")
        
        # Process the next file if any
        if self.transcription_queue:
            self.process_next_file()
        else:
            # Re-enable buttons if no more files to process
            self.is_transcribing = False
    except Exception as e:
        logger.exception(f"Error in transcription_finished: {e!s}")
        self.is_transcribing = False

def transcription_error(self, error_message, is_temp=False, temp_path=None):
    """Called when transcription encounters an error."""
    logger.error(f"Transcription error: {error_message}")
    
    # Display the error to the user
    self.display_message(txt=f"Error: {error_message}", reset=True)
    
    # Clean up temp file if this is a video conversion
    if is_temp and temp_path and os.path.exists(temp_path):
        try:
            os.remove(temp_path)
            logger.debug(f"Removed temporary file: {temp_path}")
        except Exception as e:
            logger.exception(f"Error removing temporary file: {e!s}")
    
    # Reset transcription flag
    self.is_transcribing = False
    
    # Try the next file if any
    if self.transcription_queue:
        self.process_next_file()
    else:
        self.display_message(txt="Transcription completed with errors.")

# New methods for voice visualizer
def show_voice_visualizer(self):
    """Show and fade in the voice visualizer when recording starts."""
    if not hasattr(self, "voice_visualizer_controller"):
        self.voice_visualizer_controller = VoiceVisualizer(self)
    
    # Start audio processing
    self.voice_visualizer_controller.start_processing()
    
    # Show the visualizer
    self.voice_visualizer.setVisible(True)
    
    # Fade in visualizer
    self.fade_in_visualizer = QPropertyAnimation(self.visualizer_opacity_effect, b"opacity")
    self.fade_in_visualizer.setDuration(500)  # 500ms fade in
    self.fade_in_visualizer.setStartValue(0.0)
    self.fade_in_visualizer.setEndValue(1.0)
    self.fade_in_visualizer.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    # Create dim animations for logo, title and settings button (not complete fadeout)
    # Only dim to 40% opacity instead of 0%
    self.fade_out_logo = QPropertyAnimation(self.logo_opacity_effect, b"opacity")
    self.fade_out_logo.setDuration(500)
    self.fade_out_logo.setStartValue(1.0)
    self.fade_out_logo.setEndValue(0.4)  # Dim to 40% instead of full fadeout
    self.fade_out_logo.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    self.fade_out_title = QPropertyAnimation(self.title_opacity_effect, b"opacity")
    self.fade_out_title.setDuration(500)
    self.fade_out_title.setStartValue(1.0)
    self.fade_out_title.setEndValue(0.4)  # Dim to 40% instead of full fadeout
    self.fade_out_title.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    self.fade_out_settings = QPropertyAnimation(self.settings_opacity_effect, b"opacity")
    self.fade_out_settings.setDuration(500)
    self.fade_out_settings.setStartValue(1.0)
    self.fade_out_settings.setEndValue(0.4)  # Dim to 40% instead of full fadeout
    self.fade_out_settings.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    # Fade out instruction text
    self.fade_out_instruction = QPropertyAnimation(self.instruction_opacity_effect, b"opacity")
    self.fade_out_instruction.setDuration(500)
    self.fade_out_instruction.setStartValue(1.0)
    self.fade_out_instruction.setEndValue(0.0)  # Completely hide instructions while recording
    self.fade_out_instruction.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    # Create animation group to run all animations together
    self.recording_animation_group = QtCore.QParallelAnimationGroup()
    self.recording_animation_group.addAnimation(self.fade_in_visualizer)
    self.recording_animation_group.addAnimation(self.fade_out_logo)
    self.recording_animation_group.addAnimation(self.fade_out_title)
    self.recording_animation_group.addAnimation(self.fade_out_settings)
    self.recording_animation_group.addAnimation(self.fade_out_instruction)
    
    # Start animations
    self.recording_animation_group.start()

def hide_voice_visualizer(self):
    """Fade out the voice visualizer and restore other elements when recording stops."""
    # Start animation first, then stop processing after animations complete
    
    # Fade out visualizer
    self.fade_out_visualizer = QPropertyAnimation(self.visualizer_opacity_effect, b"opacity")
    self.fade_out_visualizer.setDuration(500)  # 500ms fade out
    self.fade_out_visualizer.setStartValue(1.0)
    self.fade_out_visualizer.setEndValue(0.0)
    self.fade_out_visualizer.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    # This is a safer approach than using a callback function
    self.fade_out_visualizer.finished.connect(lambda: self.voice_visualizer.setVisible(False))
    
    # Create fade in animations for logo, title and settings button (from dimmed state)
    self.fade_in_logo = QPropertyAnimation(self.logo_opacity_effect, b"opacity")
    self.fade_in_logo.setDuration(500)
    self.fade_in_logo.setStartValue(0.4)  # From 40% dimmed state
    self.fade_in_logo.setEndValue(1.0)
    self.fade_in_logo.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    self.fade_in_title = QPropertyAnimation(self.title_opacity_effect, b"opacity")
    self.fade_in_title.setDuration(500)
    self.fade_in_title.setStartValue(0.4)  # From 40% dimmed state
    self.fade_in_title.setEndValue(1.0)
    self.fade_in_title.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    self.fade_in_settings = QPropertyAnimation(self.settings_opacity_effect, b"opacity")
    self.fade_in_settings.setDuration(500)
    self.fade_in_settings.setStartValue(0.4)  # From 40% dimmed state
    self.fade_in_settings.setEndValue(1.0)
    self.fade_in_settings.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    # Fade the instruction text back in
    self.fade_in_instruction = QPropertyAnimation(self.instruction_opacity_effect, b"opacity")
    self.fade_in_instruction.setDuration(500)
    self.fade_in_instruction.setStartValue(0.0)
    self.fade_in_instruction.setEndValue(1.0)
    self.fade_in_instruction.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    
    # Create animation group to run all animations together
    self.end_recording_animation_group = QtCore.QParallelAnimationGroup()
    self.end_recording_animation_group.addAnimation(self.fade_out_visualizer)
    self.end_recording_animation_group.addAnimation(self.fade_in_logo)
    self.end_recording_animation_group.addAnimation(self.fade_in_title)
    self.end_recording_animation_group.addAnimation(self.fade_in_settings)
    self.end_recording_animation_group.addAnimation(self.fade_in_instruction)
    
    # Start animations
    self.end_recording_animation_group.start()
    
    # Set a flag for the voice visualizer controller to stop processing
    # This avoids direct calls across threads
    if hasattr(self, "voice_visualizer_controller"):
        self.voice_visualizer_controller.is_active = False

def update_waveform(self, data):
    """Update the waveform visualization with new audio data."""
    if not hasattr(self, "waveform_plot"):
        return
        
    if not self.voice_visualizer.isVisible():
        return
        
    # Down-sample data for better visualization performance
    data_downsampled = data[::4]  # Take every 4th sample
    
    # Create x-axis time values
    time_values = np.linspace(0, len(data_downsampled), len(data_downsampled))
    
    # Update the plot
    self.waveform_plot.setData(time_values, data_downsampled)

def fade_in_instruction_text(self):
    """Fade in the instruction text with a nice animation when the app starts."""
    # Create a fade-in animation for the instruction text
    self.instruction_text_fade_in = QPropertyAnimation(self.instruction_opacity_effect, b"opacity")
    self.instruction_text_fade_in.setDuration(1000)  # 1 second fade in
    self.instruction_text_fade_in.setStartValue(0.0)
    self.instruction_text_fade_in.setEndValue(1.0)
    self.instruction_text_fade_in.setEasingCurve(QtCore.QEasingCurve.Type.InOutQuad)
    self.instruction_text_fade_in.start() 

def transcribe_audio_data(self, audio_data):
    """Transcribe audio data in memory."""
    try:
        # Unpack the audio data tuple
        data_type, audio_bytes, output_base_path = audio_data
            
        output_format = self.config.get("output_format", "srt")
        
        # Get the filename for display and logging
        filename = os.path.basename(output_base_path)
        
        # Create a BytesIO object from the audio bytes
        with io.BytesIO(audio_bytes) as audio_buffer:
            # Give the buffer a name to help some libraries
            audio_buffer.name = "audio.wav"
            # Add the original_filename attribute for better logging
            audio_buffer.original_filename = filename
            
            # Get the transcript from the model using the BytesIO object directly
            transcript = self.model_worker.transcript_file(audio_buffer)
        
        # Calculate file count for display - ensure we have valid values
        file_count_text = ""
        if hasattr(self, "current_file_index") and hasattr(self, "total_files_count"):
            if self.current_file_index > 0 and self.total_files_count > 0:
                file_count_text = f" ({self.current_file_index}/{self.total_files_count})"
        
        # Handle failed transcription
        if not transcript:
            self.display_message(txt=f"Transcription failed for: {filename}{file_count_text}")
            # Continue with the next file
            self.process_next_file()
            return
            
        # Save as TXT or SRT based on config
        if output_format == "txt":
            # Save as TXT
            with open(f"{output_base_path}.txt", "w", encoding="utf-8") as f:
                f.write(transcript["text"])
            success_message = f"Saved transcript to: {os.path.basename(output_base_path)}.txt{file_count_text}"
            self.display_message(txt=success_message, hold=True)
        else:
            # Save as SRT
            with open(f"{output_base_path}.srt", "w", encoding="utf-8") as f:
                for i, segment in enumerate(transcript["segments"]):
                    start_time = self.format_time_srt(segment["start"])
                    end_time = self.format_time_srt(segment["end"])
                    text = segment["text"].strip()
                    
                    f.write(f"{i+1}\n")
                    f.write(f"{start_time} --> {end_time}\n")
                    f.write(f"{text}\n\n")
            success_message = f"Saved transcript to: {os.path.basename(output_base_path)}.srt{file_count_text}"
            self.display_message(txt=success_message, hold=True)
        
        # Process next file to continue with the queue
        self.process_next_file()
        
    except Exception as e:
        # Calculate file count for display
        file_count_text = ""
        if hasattr(self, "current_file_index") and hasattr(self, "total_files_count"):
            if self.current_file_index > 0 and self.total_files_count > 0:
                file_count_text = f" ({self.current_file_index}/{self.total_files_count})"
                
        logger.exception(f"Error transcribing audio data: {e!s}")
        error_message = f"Error transcribing audio: {e!s}{file_count_text}"
        self.display_message(txt=error_message)
        
        # Continue with the next file
        self.process_next_file() 
        
def download_started(self):
    """Disable settings and show progress bar during download."""
    print("Starting download")
    
    # Disable UI elements with visual feedback
    self.set_ui_elements_enabled(False)
    
    # Only move the progress bar if we're not already in the process of moving it
    if not self.is_progress_bar_moving:
        self.is_progress_bar_moving = True
        
        # Make sure progress bar is visible in the parent window
        if hasattr(self.parent_window, "progressBar") and self.parent_window.progressBar is not None:
            try:
                # Temporarily reparent the progress bar to appear in our dialog
                progress_bar = self.parent_window.progressBar
                
                # Store the original parent and geometry for later restoration
                if self.original_progress_parent is None:
                    self.original_progress_parent = progress_bar.parent()
                    self.original_progress_geometry = progress_bar.geometry()
                
                # Clear any existing widgets in the placeholder layout
                for i in reversed(range(self.progress_placeholder_layout.count())): 
                    item = self.progress_placeholder_layout.itemAt(i)
                    if item.widget():
                        item.widget().setParent(None)
                
                # Add the progress bar to our layout
                self.progress_placeholder_layout.addWidget(progress_bar)
                progress_bar.setVisible(True)
                
                # Force layout update
                self.progress_placeholder.updateGeometry()
                self.progress_placeholder_layout.update()
            except RuntimeError:
                # If the progress bar has been deleted, ignore
                pass
            finally:
                # Use a direct timer call rather than connecting to prevent memory leak
                QTimer.singleShot(200, lambda: setattr(self, "is_progress_bar_moving", False))

def update_instruction_label(self):
    """Update the instruction label based on download status."""
    if hasattr(self, "instruction_label"):
        from PyQt6.QtCore import QCoreApplication
        _translate = QCoreApplication.translate
        
        if getattr(self, "is_downloading_model", False):
            # Hide instruction during download
            self.instruction_label.setText("")
        else:
            # Show instruction when not downloading
            rec_key = getattr(self, "rec_key", "CTRL+ALT+A")
            self.instruction_label.setText(_translate("MainWindow", f"Hold {rec_key} to record or drag & drop to transcribe"))