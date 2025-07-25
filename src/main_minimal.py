#!/usr/bin/env python3
"""
Minimal version of WinSTT to diagnose white screen issues.
This version skips worker initialization to isolate UI problems.
"""

import os
import sys
import traceback

# Add the root directory to Python path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Suppress warnings
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "hide"
os.environ["PYTHONWARNINGS"] = "ignore::DeprecationWarning:pygame"
os.environ["QT_LOGGING_RULES"] = "qt.gui.imageio=false"

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QFont, QIcon
from PyQt6.QtWidgets import QApplication, QLabel, QMainWindow, QMessageBox, QVBoxLayout, QWidget

from src.core.utils import get_config, resource_path


class MinimalWindow(QMainWindow):
    """Minimal window for testing UI without worker initialization."""
    
    def __init__(self):
        super().__init__()
        print("  🏗️  Creating minimal window...")
        
        # Set basic window properties
        self.setWindowTitle("WinSTT - Minimal Test")
        self.setFixedSize(400, 220)
        
        # Load and set icon
        try:
            icon_path = resource_path("resources/Windows 1 Theta.png")
            if os.path.exists(icon_path):
                self.setWindowIcon(QIcon(icon_path))
                print("  ✅ Icon loaded successfully")
            else:
                print(f"  ⚠️  Icon not found: {icon_path}")
        except Exception as e:
            print(f"  ❌ Icon loading failed: {e}")
        
        # Create central widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # Create layout
        layout = QVBoxLayout(central_widget)
        layout.setAlignment(Qt.AlignmentFlag.AlignCenter)
        
        # Create title label
        title_label = QLabel("WinSTT")
        title_font = QFont("Arial", 24, QFont.Weight.Bold)
        title_label.setFont(title_font)
        title_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title_label.setStyleSheet("color: rgb(144, 164, 174); margin: 20px;")
        layout.addWidget(title_label)
        
        # Create status label
        self.status_label = QLabel("✅ Minimal UI loaded successfully!")
        status_font = QFont("Arial", 12)
        self.status_label.setFont(status_font)
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.status_label.setStyleSheet("color: rgb(100, 200, 100); margin: 10px;")
        layout.addWidget(self.status_label)
        
        # Create info label
        info_label = QLabel("This is a minimal version for testing.\nIf you see this, the UI is working correctly.")
        info_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        info_label.setStyleSheet("color: rgb(144, 164, 174); margin: 10px; line-height: 1.4;")
        layout.addWidget(info_label)
        
        # Create config test label
        try:
            config = get_config()
            config_label = QLabel(f"✅ Config loaded: {len(config)} settings")
            config_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
            config_label.setStyleSheet("color: rgb(100, 200, 100); margin: 5px; font-size: 10px;")
            layout.addWidget(config_label)
        except Exception as e:
            config_label = QLabel(f"❌ Config error: {e}")
            config_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
            config_label.setStyleSheet("color: rgb(200, 100, 100); margin: 5px; font-size: 10px;")
            layout.addWidget(config_label)
        
        # Update status every 2 seconds
        self.update_timer = QTimer()
        self.update_timer.timeout.connect(self.update_status)
        self.update_timer.start(2000)
        self.counter = 0
        
        print("  ✅ Minimal window created successfully")
    
    def update_status(self):
        """Update status to show the UI is responsive."""
        self.counter += 1
        self.status_label.setText(f"✅ UI is responsive! (update #{self.counter})")

def main():
    """Main entry point for minimal test."""
    print("🚀 Starting WinSTT Minimal Test...")
    
    try:
        print("🎨 Creating QApplication...")
        app = QApplication(sys.argv)
        app.setQuitOnLastWindowClosed(True)
        
        print("🪟 Creating minimal window...")
        window = MinimalWindow()
        
        print("👀 Showing window...")
        window.show()
        
        print("🎉 Minimal test application started successfully!")
        print("\n💡 What this test shows:")
        print("   - If you see a window with text: UI components work")
        print("   - If window is white/blank: There's a Qt/UI issue")
        print("   - If app crashes: Check the error messages")
        print("\n🚀 Starting event loop...")
        
        return app.exec()
        
    except Exception as e:
        error_msg = f"Minimal test failed: {e}"
        print(f"❌ {error_msg}")
        print(f"Traceback: {traceback.format_exc()}")
        
        try:
            QMessageBox.critical(None, "Minimal Test Error", f"{error_msg}\n\nSee console for details.")
        except:
            pass  # If even MessageBox fails, just print
            
        return 1

if __name__ == "__main__":
    sys.exit(main()) 