#!/usr/bin/env python3
"""
Asynchronous version of WinSTT that shows a loading screen while initializing.
This fixes the white screen issue by ensuring the UI remains responsive.
"""

import atexit
import os
import socket
import subprocess
import sys
import tempfile
import traceback

# Add the root directory to Python path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.core.utils import resource_path

# Suppress pygame welcome message and warnings
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "hide"
os.environ["PYTHONWARNINGS"] = "ignore::DeprecationWarning:pygame"
os.environ["QT_LOGGING_RULES"] = "qt.gui.imageio=false"

# Import win32gui for handling existing window activation (Windows only)
HAS_WIN32GUI = False
if os.name in {"nt", "win32"}:
    try:
        import win32gui
        HAS_WIN32GUI = True
    except ImportError:
        HAS_WIN32GUI = False

# Suppression patch for subprocess warnings
original_popen = subprocess.Popen

def patched_popen(*args, **kwargs):
    if "stderr" not in kwargs:
        kwargs["stderr"] = subprocess.DEVNULL
    return original_popen(*args, **kwargs)

subprocess.Popen = patched_popen

# Import PyQt6 components at module level
from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QFont, QIcon, QPainter, QPixmap
from PyQt6.QtWidgets import (
    QApplication,
    QLabel,
    QProgressBar,
    QSplashScreen,
    QVBoxLayout,
    QWidget,
)


def check_instance():
    """Check if another instance is already running."""
    print("🔍 Checking for existing instance...")
    
    # Create a temporary file for the lock
    temp_dir = tempfile.gettempdir()
    lock_file = os.path.join(temp_dir, "winstt.lock")
    
    try:
        # Try to create a socket to check if the app is running
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("localhost", 65432))
        sock.close()
        
        # Create lock file
        with open(lock_file, "w") as f:
            f.write(str(os.getpid()))
        
        # Register cleanup
        atexit.register(lambda: os.path.exists(lock_file) and os.remove(lock_file))
        
        return False  # No other instance
    except OSError:
        print("🔄 Another instance is already running")
        if HAS_WIN32GUI:
            try:
                # Try to bring existing window to front
                def enum_windows_callback(hwnd, windows):
                    if win32gui.IsWindowVisible(hwnd):
                        window_title = win32gui.GetWindowText(hwnd)
                        if "WinSTT" in window_title:
                            windows.append(hwnd)
                    return True
                
                windows = []
                win32gui.EnumWindows(enum_windows_callback, windows)
                
                if windows:
                    for hwnd in windows:
                        win32gui.ShowWindow(hwnd, 9)  # SW_RESTORE
                        win32gui.SetForegroundWindow(hwnd)
                    print("✅ Brought existing window to front")
                else:
                    print("⚠️  Could not find existing window")
            except Exception as e:
                print(f"⚠️  Could not activate existing window: {e}")
        return True  # Another instance exists

def main():
    """Main application entry point with async initialization."""
    print("🚀 Starting WinSTT application...")
    
    # Check for existing instance
    if check_instance():
        print("🔄 Existing instance found, exiting...")
        return
    
    print("WinSTT application starting...")
    
    try:
        print("📦 Importing UI components...")
        from src.ui.main_window import Window
        print("✅ UI components imported successfully")
        
        print("🎨 Creating QApplication...")
        app = QApplication(sys.argv)
        app.setQuitOnLastWindowClosed(False)
        
        # Set application icon
        try:
            icon_path = resource_path("resources/Windows 1 Theta.png")
            if os.path.exists(icon_path):
                app.setWindowIcon(QIcon(icon_path))
                print(f"✅ Application icon set: {icon_path}")
            else:
                print(f"⚠️  Icon file not found: {icon_path}")
        except Exception as e:
            print(f"⚠️  Could not set application icon: {e}")
        
        # Create loading screen
        print("📱 Creating loading screen...")
        loading_screen = create_loading_screen()
        loading_screen.show()
        
        # Process initial events to show loading screen
        app.processEvents()
        
        print("🪟 Creating main window in background...")
        
        # Create window but don't show it yet
        window = Window()
        
        # Set up a timer to check when initialization is complete
        init_timer = QTimer()
        init_timer.timeout.connect(lambda: check_initialization_complete(window, loading_screen, init_timer))
        init_timer.start(100)  # Check every 100ms
        
        # Connect to worker initialization signals to update loading screen
        setup_loading_progress(window, loading_screen, init_timer)
        
        print("✅ Loading screen shown, initialization in progress...")
        print("🔄 Starting main event loop...")
        
        # Start the event loop
        sys.exit(app.exec())
        
    except Exception as e:
        print(f"💥 Application crashed: {e}")
        traceback.print_exc()
        sys.exit(1)

def create_loading_screen():
    """Create a beautiful loading screen."""
    splash = QSplashScreen()
    splash.setFixedSize(400, 300)
    
    # Create a custom widget for the loading screen
    widget = QWidget()
    layout = QVBoxLayout(widget)
    layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
    layout.setSpacing(20)
    
    # App logo/icon
    try:
        icon_path = resource_path("resources/Windows 1 Theta.png")
        if os.path.exists(icon_path):
            icon_label = QLabel()
            pixmap = QPixmap(icon_path)
            # Scale the icon to a reasonable size
            scaled_pixmap = pixmap.scaled(64, 64, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            icon_label.setPixmap(scaled_pixmap)
            icon_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
            layout.addWidget(icon_label)
    except Exception:
        pass
    
    # App title
    title_label = QLabel("WinSTT")
    title_font = QFont("Roboto", 24, QFont.Weight.Bold)
    title_label.setFont(title_font)
    title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    title_label.setStyleSheet("color: #ffffff; margin-bottom: 10px;")
    layout.addWidget(title_label)
    
    # Subtitle
    subtitle_label = QLabel("Speech-to-Text Application")
    subtitle_font = QFont("Roboto", 12)
    subtitle_label.setFont(subtitle_font)
    subtitle_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    subtitle_label.setStyleSheet("color: #cccccc; margin-bottom: 20px;")
    layout.addWidget(subtitle_label)
    
    # Loading status
    status_label = QLabel("Initializing...")
    status_font = QFont("Roboto", 10)
    status_label.setFont(status_font)
    status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
    status_label.setStyleSheet("color: #aaaaaa; margin-bottom: 10px;")
    layout.addWidget(status_label)
    
    # Progress bar
    progress_bar = QProgressBar()
    progress_bar.setRange(0, 0)  # Indeterminate progress
    progress_bar.setStyleSheet("""
        QProgressBar {
            border: 2px solid #555555;
            border-radius: 8px;
            background-color: #2b2b2b;
            text-align: center;
            height: 20px;
        }
        QProgressBar::chunk {
            background-color: #4CAF50;
            border-radius: 6px;
        }
    """)
    layout.addWidget(progress_bar)
    
    # Set dark theme
    widget.setStyleSheet("""
        QWidget {
            background-color: #1e1e1e;
            color: #ffffff;
        }
    """)
    
    # Create pixmap and paint the widget on it
    pixmap = QPixmap(400, 300)
    pixmap.fill(Qt.GlobalColor.transparent)
    
    painter = QPainter(pixmap)
    widget.render(painter)
    painter.end()
    
    splash.setPixmap(pixmap)
    splash.setWindowFlags(Qt.WindowType.SplashScreen | Qt.WindowType.WindowStaysOnTopHint)
    
    # Store references for updating
    splash.status_label = status_label
    splash.progress_bar = progress_bar
    
    return splash

def setup_loading_progress(window, loading_screen, timer):
    """Set up progress tracking for worker initialization."""
    # Track initialization states
    window._init_states = {
        "vad": False,
        "model": False,
        "listener": False,
        "ui_complete": True,  # UI is already complete
    }
    
    # Define signal handlers
    def on_vad_initialized():
        print("✅ VAD initialized")
        loading_screen.status_label.setText("VAD initialized...")
        window._init_states["vad"] = True
        check_initialization_complete(window, loading_screen, timer)
    
    def on_model_initialized():
        print("✅ Model initialized")
        loading_screen.status_label.setText("Model loaded...")
        window._init_states["model"] = True
        check_initialization_complete(window, loading_screen, timer)
    
    def on_listener_initialized():
        print("✅ Listener initialized")
        loading_screen.status_label.setText("Listener ready...")
        window._init_states["listener"] = True
        check_initialization_complete(window, loading_screen, timer)
    
    # Connect to worker signals for init events
    try:
        if hasattr(window, "vad_worker"):
            window.vad_worker.initialized.connect(on_vad_initialized)

        if hasattr(window, "model_worker"):
            window.model_worker.initialized.connect(on_model_initialized)
            # Connect to display_message_signal to track download progress
            def on_model_progress(txt=None, filename=None, percentage=None, hold=False, reset=None):
                try:
                    if percentage is not None:
                        loading_screen.progress_bar.setRange(0, 100)
                        loading_screen.progress_bar.setValue(int(percentage))
                        if filename:
                            loading_screen.status_label.setText(f"Downloading {filename}... {int(percentage)}%")
                        elif txt:
                            loading_screen.status_label.setText(txt)
                    elif reset:
                        loading_screen.progress_bar.setRange(0, 0)
                except Exception:
                    pass

            window.model_worker.display_message_signal.connect(on_model_progress)

        if hasattr(window, "listener_worker"):
            window.listener_worker.initialized.connect(on_listener_initialized)
    except Exception as e:
        print(f"⚠️  Could not connect to worker signals: {e}")

def check_initialization_complete(window, loading_screen, timer):
    """Check if all workers are initialized and show the main window."""
    try:
        # Check if all workers are ready
        states = window._init_states
        all_ready = all(states.values())
        
        if all_ready:
            print("🎉 All workers initialized, showing main window...")
            loading_screen.status_label.setText("Ready!")
            loading_screen.progress_bar.setRange(0, 100)
            loading_screen.progress_bar.setValue(100)
            
            # Short delay to show completion
            QTimer.singleShot(500, lambda: finalize_startup(window, loading_screen, timer))
    except Exception as e:
        print(f"⚠️  Error checking initialization: {e}")
        # Fallback: show window after 5 seconds
        if not hasattr(check_initialization_complete, "_fallback_triggered"):
            check_initialization_complete._fallback_triggered = True
            QTimer.singleShot(5000, lambda: finalize_startup(window, loading_screen, timer))

def finalize_startup(window, loading_screen, timer):
    """Finalize the startup process."""
    try:
        timer.stop()
        loading_screen.close()
        window.show()
        window.raise_()
        window.activateWindow()
        print("✅ WinSTT startup complete!")
    except Exception as e:
        print(f"⚠️  Error finalizing startup: {e}")
        # Force show the window anyway
        try:
            loading_screen.close()
            window.show()
        except:
            pass

if __name__ == "__main__":
    main() 