#!/usr/bin/env python3
"""
Simple version that mirrors winSTT.py's successful initialization pattern.
Shows window FIRST, then initializes workers in background.
"""

import atexit
import os
import socket
import subprocess
import sys
import tempfile
from unittest.mock import patch

# Add the root directory to Python path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import contextlib

from src.core.utils import resource_path

# Suppress pygame welcome message and warnings
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "hide"
os.environ["PYTHONWARNINGS"] = "ignore::DeprecationWarning:pygame"
os.environ["QT_LOGGING_RULES"] = "qt.gui.imageio=false"

# Import win32gui for handling existing window activation (Windows only)
HAS_WIN32GUI = False
if os.name in ("nt", "win32"):
    try:
        import win32gui
        HAS_WIN32GUI = True
    except ImportError:
        HAS_WIN32GUI = False

# Suppression patch for subprocess
original_popen = subprocess.Popen

def suppress_subprocess_call(*args, **kwargs):
    # Suppress the console window
    CREATE_NO_WINDOW = 0x08000000
    kwargs["creationflags"] = kwargs.get("creationflags", 0) | CREATE_NO_WINDOW
    return original_popen(*args, **kwargs)

# Create a unique socket name based on the app name
socket_name = os.path.join(tempfile.gettempdir(), "winstt_single_instance.sock")
single_instance_socket = None

# Function to check for an existing instance
def is_already_running():
    global single_instance_socket
    try:
        # Try to create and bind a socket
        single_instance_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        single_instance_socket.bind(("localhost", 47123))  # Use a unique, unlikely-to-be-used port
        # If we get here, no other instance is running
        atexit.register(cleanup_socket)
        return False
    except OSError:
        # Socket is already in use, another instance is running
        return True

# Function to clean up socket on exit
def cleanup_socket():
    global single_instance_socket
    if single_instance_socket:
        single_instance_socket.close()

# Import UI components with patch to suppress subprocess console window
with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
    from PyQt6.QtCore import QTimer
    from PyQt6.QtGui import QIcon
    from PyQt6.QtWidgets import QApplication, QMessageBox

    # Import our logger module
    from logger import setup_logger

def main():
    """Main entry point - mirrors winSTT.py successful pattern"""
    # Set up logger
    logger = setup_logger()
    
    print("🚀 Starting WinSTT application (simple version)...")
    
    # Import the UI components with patch
    with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
        from src.ui.main_window import Window
    
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setWindowIcon(QIcon(resource_path("resources/Windows 1 Theta.png")))
    
    # Check if app is already running
    if is_already_running():
        print("🔄 Another instance already running, exiting...")
        # Handle existing instance (same as original)
        try:
            if sys.platform == "win32":
                if HAS_WIN32GUI:
                    def enum_windows_callback(hwnd, result_list):
                        if win32gui.IsWindowVisible(hwnd):
                            window_title = win32gui.GetWindowText(hwnd)
                            if window_title == "WinSTT":
                                result_list.append(hwnd)
                        return True
                    
                    hwnd_list = []
                    win32gui.EnumWindows(enum_windows_callback, hwnd_list)
                    
                    if hwnd_list:
                        win32gui.ShowWindow(hwnd_list[0], 9)  # SW_RESTORE
                        win32gui.SetForegroundWindow(hwnd_list[0])
                else:
                    logger.warning("win32gui module not found. Install with: pip install pywin32")
                    QMessageBox.warning(None, "WinSTT", "Another instance is already running. The pywin32 package is required to activate the existing window.")
            
            logger.info("An instance of WinSTT is already running. Exiting.")
            sys.exit(0)
        except Exception as e:
            logger.exception(f"Error activating existing instance: {e}")
            QMessageBox.warning(None, "WinSTT", "An instance of WinSTT is already running.")
            sys.exit(0)
    
    try:
        print("🪟 Creating main window...")
        # Create window but DON'T initialize workers yet
        window = Window()
        
        print("🎨 Showing window FIRST (like winSTT.py)...")
        window.show()
        
        # CRITICAL: Process events to ensure window appears
        app.processEvents()
        
        print("✅ Window visible! Now starting worker initialization...")
        
        # Initialize workers AFTER window is shown - using chunked initialization to keep UI responsive
        def start_worker_init():
            print("🔧 Starting worker initialization (chunked for UI responsiveness)...")
            print(f"🔍 Cache will be at: {resource_path('cache')}")
            window.display_message(txt="Initializing workers...")
            
            # Use QTimer to break up the initialization into chunks
            init_steps = []
            
            def init_vad():
                print("📊 Initializing VAD...")
                window.display_message(txt="Initializing VAD...")
                try:
                    # Initialize VAD worker and thread
                    if not hasattr(window, "vad_worker"):
                        window.vad_worker = window.VadWorker()
                        window.vad_worker.moveToThread(window.vad_thread)
                        window.vad_worker.initialized.connect(lambda: window.display_message(txt="VAD Ready"))
                        window.vad_worker.error.connect(lambda error_message: window.display_message(txt=f"Error: {error_message}"))
                        window.vad_thread.started.connect(window.vad_worker.run)
                        window.vad_thread.start()
                    app.processEvents()  # Keep UI responsive
                    QTimer.singleShot(100, init_steps.pop(0) if init_steps else lambda: None)
                except Exception as e:
                    print(f"⚠️ VAD initialization failed: {e}")
                    window.display_message(txt=f"VAD Error: {e}")
            
            def init_model():
                print("📊 Initializing Model...")
                window.display_message(txt="Loading AI model...")
                try:
                    # Initialize Model worker and thread
                    if hasattr(window, "model_worker"):
                        window.model_thread.quit()
                        window.model_thread.wait()
                        window.model_worker.model.clear_sessions()
                        window.model_worker.deleteLater()
                        window.model_thread.deleteLater()
                        window.model_thread = QThread()
                    window.model_worker = window.ModelWorker(window.selected_model, window.selected_quantization)
                    window.model_worker.moveToThread(window.model_thread)
                    
                    # Create a safe display message handler
                    def safe_display_message(txt=None, filename=None, percentage=None, hold=False, reset=None):
                        with contextlib.suppress(RuntimeError):
                            window.display_message(txt, filename, percentage, hold, reset)
                    
                    window.model_worker.display_message_signal.connect(safe_display_message)
                    window.model_worker.initialized.connect(lambda: window.display_message(txt="Model Ready"))
                    window.model_worker.initialized.connect(lambda: QTimer.singleShot(100, init_steps.pop(0) if init_steps else lambda: None))
                    window.model_worker.error.connect(lambda error_message: window.display_message(txt=f"Error: {error_message}"))
                    window.model_thread.started.connect(window.model_worker.run)
                    window.model_thread.start()
                except Exception as e:
                    print(f"⚠️ Model initialization failed: {e}")
                    window.display_message(txt=f"Model Error: {e}")
            
            def init_listener():
                print("📊 Initializing Listener...")
                window.display_message(txt="Setting up voice recognition...")
                
                try:
                    # Initialize Listener worker and thread (this enables the recording key)
                    if hasattr(window, "model_worker") and hasattr(window.model_worker, "model") and hasattr(window, "vad_worker") and hasattr(window.vad_worker, "vad"):
                        print("✅ Prerequisites met, initializing listener...")
                        
                        if not window.started_listener:
                            window.started_listener = True
                        elif hasattr(window, "listener_worker"):
                            window.listener_worker.stop()
                            window.listener_thread.quit()
                            window.listener_thread.wait()
                            window.listener_worker.deleteLater()
                            window.listener_thread.deleteLater()
                            window.listener_thread = QThread()
                        
                        # Create a safe display message handler
                        def safe_display_message(txt=None, filename=None, percentage=None, hold=False, reset=None):
                            try:
                                if txt:
                                    window.display_message(txt=txt, filename=filename, percentage=percentage, hold=hold, reset=reset)
                            except Exception as e:
                                print(f"Error in display_message: {e}")
                        
                        window.listener_worker = window.ListenerWorker(window.model_worker.model, window.vad_worker.vad, window.rec_key)
                        window.listener_worker.moveToThread(window.listener_thread)
                        window.listener_worker.transcription_ready.connect(window.handle_transcription)
                        window.listener_worker.error.connect(lambda error_message: window.display_message(txt=f"Error: {error_message}"))
                        window.listener_worker.initialized.connect(lambda: window.display_message(txt="Recording ready!"))
                        
                        # Create a safe display message handler
                        def safe_display_message(txt=None, filename=None, percentage=None, hold=False, reset=None):
                            try:
                                if txt:
                                    window.display_message(txt=txt, filename=filename, percentage=percentage, hold=hold, reset=reset)
                            except Exception as e:
                                print(f"Error in display_message: {e}")
                        
                        window.listener_worker.display_message_signal.connect(safe_display_message)
                        
                        window.listener_thread.started.connect(window.listener_worker.run)
                        window.listener_thread.start()
                        
                        # Set initial start_sound based on enable_recording_sound
                        if window.enable_recording_sound and hasattr(window.listener_worker, "listener"):
                            # Make sure the sound file path is correct
                            sound_path = resource_path("resources/splash.mp3")
                            window.listener_worker.listener.start_sound_file = sound_path
                        elif hasattr(window.listener_worker, "listener"):
                            window.listener_worker.listener.start_sound_file = None
                            window.listener_worker.listener.start_sound = None
                    
                    app.processEvents()  # Keep UI responsive
                    QTimer.singleShot(100, init_steps.pop(0) if init_steps else lambda: None)
                except Exception as e:
                    print(f"⚠️ Listener initialization failed: {e}")
                    window.display_message(txt=f"Listener Error: {e}")
            
            def init_complete():
                window.display_message(txt=f"Ready! Press {window.rec_key} to record.")
                print(f"✅ Ready! Press {window.rec_key} to start recording.")
            
            # Queue the initialization steps - IMPORTANT: Model must come before Listener!
            init_steps.extend([init_model, init_listener, init_complete])
            
            # Start with VAD
            QTimer.singleShot(50, init_vad)
        
        # Start worker initialization 100ms after window is shown
        QTimer.singleShot(100, start_worker_init)
        
        logger.info("WinSTT application started successfully")
        print("🚀 Starting event loop...")
        
        sys.exit(app.exec())
        
    except Exception as e:
        logger.exception(f"Failed to start application: {e}")
        print(f"💥 Application crashed: {e}")
        QMessageBox.critical(None, "WinSTT Error", f"Failed to start application: {e!s}")
        sys.exit(1)

if __name__ == "__main__":
    main() 