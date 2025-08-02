import os

import onnxruntime as ort
import pyqtgraph as pg
from PyQt6 import QtCore, QtGui
from PyQt6.QtCore import Qt, QThread
from PyQt6.QtGui import QAction, QIcon
from PyQt6.QtWidgets import (
    QApplication,
    QGraphicsOpacityEffect,
    QGraphicsView,
    QLabel,
    QMainWindow,
    QProgressBar,
    QPushButton,
    QSizePolicy,
    QSystemTrayIcon,
    QWidget,
)

from logger import setup_logger
from src.core.utils import get_config, resource_path
from src.ui import window_methods
from src.workers import ListenerWorker, LLMWorker, ModelWorker, VadWorker

logger = setup_logger()

class Ui_MainWindow:
    def setupUi(self, MainWindow):
        self.script_path = (os.path.dirname(os.path.abspath(__file__)))
        # print(self.script_path)
        self.acc = "CUDAExecutionProvider" in ort.get_available_providers()
        MainWindow.setObjectName("MainWindow")
        MainWindow.setEnabled(True)
        MainWindow.setFixedSize(400, 220)  # Initially reduce height, will fine-tune later
        
        # Get icon path
        icon_path = resource_path("resources/Windows 1 Theta.png")
        icon = QIcon(icon_path)
        MainWindow.setWindowIcon(icon)
        
        sizePolicy = QSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        sizePolicy.setHorizontalStretch(0)
        sizePolicy.setVerticalStretch(0)
        sizePolicy.setHeightForWidth(MainWindow.sizePolicy().hasHeightForWidth())
        MainWindow.setSizePolicy(sizePolicy)
        palette = QtGui.QPalette()
        brush = QtGui.QBrush(QtGui.QColor(46, 52, 64))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Active, QtGui.QPalette.ColorRole.Base, brush)
        brush = QtGui.QBrush(QtGui.QColor(20, 27, 31))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Active, QtGui.QPalette.ColorRole.Window, brush)
        brush = QtGui.QBrush(QtGui.QColor(46, 52, 64))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Inactive, QtGui.QPalette.ColorRole.Base, brush)
        brush = QtGui.QBrush(QtGui.QColor(20, 27, 31))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Inactive, QtGui.QPalette.ColorRole.Window, brush)
        brush = QtGui.QBrush(QtGui.QColor(20, 27, 31))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Disabled, QtGui.QPalette.ColorRole.Base, brush)
        brush = QtGui.QBrush(QtGui.QColor(20, 27, 31))
        brush.setStyle(Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Disabled, QtGui.QPalette.ColorRole.Window, brush)
        MainWindow.setPalette(palette)
        self.centralwidget = QWidget(parent=MainWindow)
        self.centralwidget.setEnabled(True)
        sizePolicy = QSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        sizePolicy.setHorizontalStretch(0)
        sizePolicy.setVerticalStretch(0)
        sizePolicy.setHeightForWidth(self.centralwidget.sizePolicy().hasHeightForWidth())
        self.centralwidget.setSizePolicy(sizePolicy)
        self.centralwidget.setObjectName("centralwidget")
        self.label = QLabel(parent=self.centralwidget)
        self.label.setGeometry(QtCore.QRect(262, 189, 161, 31))
        self.label.setStyleSheet("""QLabel {
                                    color: rgb(144, 164, 174);
                                }
                                """)
        font = QtGui.QFont()
        font.setFamily("Roboto")
        self.label.setFont(font)
        self.label.setObjectName("label")
        self.WinSTT = QLabel(parent=self.centralwidget)
        self.WinSTT.setStyleSheet("""QLabel {
                                    color: rgb(144, 164, 174);
                                }
                                """)
        self.WinSTT.setGeometry(QtCore.QRect(150, 10, 131, 31))
        font = QtGui.QFont()
        font.setFamily("Codec Pro ExtraBold")
        font.setPointSize(24)
        font.setBold(True)
        font.setWeight(75)
        self.WinSTT.setFont(font)
        self.WinSTT.setMouseTracking(True)
        self.WinSTT.setTextFormat(QtCore.Qt.TextFormat.PlainText)
        self.WinSTT.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        self.WinSTT.setObjectName("WinSTT")
        self.label_3 = QLabel(parent=self.centralwidget)
        self.label_3.setStyleSheet("color: rgb(144, 164, 174);")
        self.label_3.setGeometry(QtCore.QRect(17, 85, 370, 30))
        self.label_3.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        font = QtGui.QFont()
        font.setFamily("Input")
        font.setPointSize(10)
        self.label_3.setFont(font)
        self.label_3.setObjectName("label_3")
        self.progressBar = QProgressBar(parent=self.centralwidget)
        self.progressBar.setGeometry(QtCore.QRect(60, 120, 290, 14))
        self.progressBar.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        self.progressBar.setStyleSheet("""
                                            QProgressBar {background-color: rgb(8, 11, 14);
                                            color: rgb(144, 164, 174);
                                            border-radius: 5px}
                                            """)
        font = QtGui.QFont()
        font.setFamily("Input")
        self.progressBar.setFont(font)
        self.progressBar.setProperty("value", 0)
        self.progressBar.setObjectName("progressBar")
        self.progressBar.setVisible(False)
        self.graphicsView_2 = QGraphicsView(parent=self.centralwidget)
        self.graphicsView_2.setGeometry(QtCore.QRect(0, 190, 411, 31))
        palette = QtGui.QPalette()
        brush = QtGui.QBrush(QtGui.QColor(8, 11, 14))
        brush.setStyle(QtCore.Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Active, QtGui.QPalette.ColorRole.Base, brush)
        brush = QtGui.QBrush(QtGui.QColor(8, 11, 14))
        brush.setStyle(QtCore.Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Inactive, QtGui.QPalette.ColorRole.Base, brush)
        brush = QtGui.QBrush(QtGui.QColor(20, 27, 31))
        brush.setStyle(QtCore.Qt.BrushStyle.SolidPattern)
        palette.setBrush(QtGui.QPalette.ColorGroup.Disabled, QtGui.QPalette.ColorRole.Base, brush)
        self.graphicsView_2.setPalette(palette)
        self.graphicsView_2.setObjectName("graphicsView_2")
        self.label_2 = QLabel(parent=self.centralwidget)
        self.label_2.setGeometry(QtCore.QRect(160, 10, 21, 21))
        self.label_2.setText("")
        self.label_2.setPixmap(QtGui.QPixmap(resource_path("resources/Windows 1 Theta.png")))
        self.label_2.setScaledContents(True)
        self.label_2.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        self.label_2.setObjectName("label_2")
        
        # Add settings button with gear icon at top right
        self.settingsButton = QPushButton(parent=self.centralwidget)
        self.settingsButton.setGeometry(QtCore.QRect(360, 10, 24, 24))
        self.settingsButton.setFixedSize(24, 24)
        self.settingsButton.setObjectName("settingsButton")
        self.settingsButton.setToolTip("Settings")
        self.settingsButton.setIcon(QIcon(resource_path("resources/gear.png")))
        self.settingsButton.setIconSize(QtCore.QSize(16, 16))
        self.settingsButton.setStyleSheet("""
            QPushButton {
                background-color: transparent;
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129)
            }
            QPushButton:hover {
                background-color: rgba(78, 106, 129, 0.5);  /* Semi-transparent on hover */
            }
        """)
        
        self.label_4 = QLabel(parent=self.centralwidget)
        self.label_4.setGeometry(QtCore.QRect(360, 190, 31, 31))
        self.label_4.setText("")
        switch_on_path = resource_path("resources/switch-on.png")
        switch_off_path = resource_path("resources/switch-off.png")
        self.label_4.setPixmap(QtGui.QPixmap(switch_on_path if self.acc else switch_off_path))
        self.label_4.setScaledContents(True)
        self.label_4.setObjectName("label_4")
        self.label_5 = QLabel(parent=self.centralwidget)
        self.label_5.setGeometry(QtCore.QRect(0, -5, 401, 51))
        self.label_5.setText("")
        self.label_5.setPixmap(QtGui.QPixmap(resource_path("resources/Untitled-1.png")))
        self.label_5.setScaledContents(True)
        self.label_5.setObjectName("label_5")
        self.label_5.raise_()
        self.graphicsView_2.raise_()
        self.label.raise_()
        self.WinSTT.raise_()
        self.label_3.raise_()
        self.progressBar.raise_()
        self.label_2.raise_()
        self.settingsButton.raise_() # Raise settings button
        # Remove raising combo boxes
        self.label_4.raise_()
        
        # Add voice visualizer directly over the Untitled-1.png image
        self.voice_visualizer = pg.PlotWidget(parent=self.centralwidget)
        self.voice_visualizer.setGeometry(QtCore.QRect(0, -5, 400, 51))  # Full width
        self.voice_visualizer.setBackground((0, 0, 0, 0))  # Transparent background
        self.voice_visualizer.showAxis("left", False)
        self.voice_visualizer.showAxis("bottom", False)
        self.voice_visualizer.setVisible(False)  # Hidden by default
        self.voice_visualizer.setObjectName("voice_visualizer")
        self.voice_visualizer.setStyleSheet("""
            border: none;
        """)
        
        # Create waveform plot with red color (#bd2e2d)
        self.waveform_plot = self.voice_visualizer.plot([], [], pen=pg.mkPen(color=(189, 46, 45), width=2.5))
        
        # Create opacity effect for the visualizer
        self.visualizer_opacity_effect = QGraphicsOpacityEffect(self.voice_visualizer)
        self.voice_visualizer.setGraphicsEffect(self.visualizer_opacity_effect)
        self.visualizer_opacity_effect.setOpacity(0.0)
        
        # Create opacity effects for elements that should fade when recording
        self.logo_opacity_effect = QGraphicsOpacityEffect(self.label_2)
        self.label_2.setGraphicsEffect(self.logo_opacity_effect)

        self.title_opacity_effect = QGraphicsOpacityEffect(self.WinSTT)
        self.WinSTT.setGraphicsEffect(self.title_opacity_effect)

        self.settings_opacity_effect = QGraphicsOpacityEffect(self.settingsButton)
        self.settingsButton.setGraphicsEffect(self.settings_opacity_effect)
        
        # Add new instruction text label between header and progress bar
        self.instruction_label = QLabel(parent=self.centralwidget)
        self.instruction_label.setGeometry(QtCore.QRect(17, 50, 370, 30))
        self.instruction_label.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
        # Unique color - a teal/cyan that contrasts with the blue header and red waveform
        self.instruction_label.setStyleSheet("""
            color:rgba(169, 169, 169, 1);
            font-style: italic;
        """)
        font = QtGui.QFont()
        font.setFamily("Roboto")
        font.setPointSize(9)
        self.instruction_label.setFont(font)
        self.instruction_label.setObjectName("instruction_label")

        # Create opacity effect for the instruction label
        self.instruction_opacity_effect = QGraphicsOpacityEffect(self.instruction_label)
        self.instruction_label.setGraphicsEffect(self.instruction_opacity_effect)
        self.instruction_opacity_effect.setOpacity(0.0)  # Start invisible for fade-in effect
        
        # Reposition other elements for compact layout
        self.label_3.setGeometry(QtCore.QRect(17, 85, 370, 30))  # Message text
        self.progressBar.setGeometry(QtCore.QRect(60, 120, 290, 14))  # Progress bar
        self.graphicsView_2.setGeometry(QtCore.QRect(0, 190, 411, 31))  # Bottom status bar
        self.label.setGeometry(QtCore.QRect(262, 189, 161, 31))  # Hardware acceleration label
        self.label_4.setGeometry(QtCore.QRect(360, 190, 31, 31))  # Acceleration switch
        
        # Update element raising order to include the instruction label
        self.graphicsView_2.raise_()
        self.label.raise_()
        self.label_3.raise_()
        self.progressBar.raise_()
        self.label_4.raise_()
        self.voice_visualizer.raise_()  # Visualizer above header image
        self.instruction_label.raise_()  # Instruction text above visualizer
        self.label_2.raise_()  # Logo above visualizer
        self.WinSTT.raise_()  # Text above visualizer
        self.settingsButton.raise_()  # Settings button above visualizer
        
        MainWindow.setCentralWidget(self.centralwidget)
        self.retranslateUi(MainWindow)

    def retranslateUi(self, MainWindow):
        _translate = QtCore.QCoreApplication.translate
        MainWindow.setWindowTitle(_translate("MainWindow", "WinSTT"))
        self.label.setText(_translate("MainWindow", "H/W Acceleration:"))
        self.WinSTT.setText(_translate("MainWindow", "STT"))
        # Get the current rec_key from the MainWindow if available, otherwise use the default
        rec_key = MainWindow.rec_key if hasattr(MainWindow, "rec_key") else "CTRL+ALT+A"
        # Only show instruction if not downloading models
        if not getattr(MainWindow, 'is_downloading_model', False):
            self.instruction_label.setText(_translate("MainWindow", f"Hold {rec_key} to record or drag & drop to transcribe"))
        else:
            self.instruction_label.setText(_translate("MainWindow", ""))
        self.label_3.setText(_translate("MainWindow", ""))

class Window(QMainWindow, Ui_MainWindow):
    def __init__(self):
        super().__init__()
        print("  🏗️  Setting up UI...")
        self.setupUi(self)
        print("  ✅ UI setup complete")
        
        # Enable drag and drop for the main window
        self.setAcceptDrops(True)
        
        # Load config first
        self.config = get_config()
        
        # Initialize with defaults, then override with config values
        self.start_sound = resource_path("resources/splash.mp3")
        self.enable_recording_sound = True  # Default to enabled
        self.current_output_srt = False  # Default to no SRT output
        self.rec_key = "CTRL+ALT+A"  # Store the rec_key as a property
        
        # Initialize selected_model from config
        self.selected_model = self.config.get("model", "whisper-turbo")
        
        # LLM settings
        self.llm_enabled = False  # Default to disabled
        self.llm_model = "gemma-3-1b-it"  # Default model
        self.llm_quantization = "Full"  # Default quantization
        self.llm_prompt = "You are a helpful assistant."  # Default system prompt
        
        # Dialog will be initialized when needed
        self.dialog = None
        
        # Flag to track if transcription is in progress
        self.is_transcribing = False
        self.transcription_queue = []  # Queue for multiple file transcription
        
        # Dynamically determine the MouseButtonPress event type
        try:
            self.MOUSE_PRESS = QtCore.QEvent.MouseButtonPress  # PyQt5
        except AttributeError:
            self.MOUSE_PRESS = QtCore.QEvent.Type.MouseButtonPress  # PyQt6
        
        # Connect settings button to open settings dialog
        self.settingsButton.clicked.connect(self.open_settings)
                
        self.minimize_counter = 0
        
        # Set initial quantization based on config or hardware capability
        self.acc = ort.get_device() == "GPU"
        self.selected_quantization = self.config.get("quantization", "Full" if self.acc else "Quantized")

        # Override with values from config if available
        self.selected_model = self.config.get("model", self.selected_model)
        self.enable_recording_sound = self.config.get("enable_sound", self.enable_recording_sound)
        self.start_sound = self.config.get("sound_path", self.start_sound)
        self.current_output_srt = self.config.get("output_srt", self.current_output_srt)
        self.rec_key = self.config.get("rec_key", self.rec_key)
        
        # Override LLM settings from config if available
        self.llm_enabled = self.config.get("llm_enabled", self.llm_enabled)
        self.llm_model = self.config.get("llm_model", self.llm_model)
        self.llm_quantization = self.config.get("llm_quantization", self.llm_quantization)
        self.llm_prompt = self.config.get("llm_prompt", self.llm_prompt)

        # Initialize threads
        self.vad_thread = QThread()
        self.model_thread = QThread()
        self.listener_thread = QThread()
        self.started_listener = False
        
        # Store references to worker classes
        self.VadWorker = VadWorker
        self.ModelWorker = ModelWorker
        self.ListenerWorker = ListenerWorker
        self.LLMWorker = LLMWorker
        
        # Initialize actions for menus
        self.show_action = QAction("Show", self)
        self.settings_action = QAction("Settings", self)
        self.close_action = QAction("Exit", self)
        
        # Connect settings action
        self.settings_action.triggered.connect(self.open_settings)
        # Connect close action
        self.close_action.triggered.connect(self.close_app)
        
        # DON'T initialize workers here - will be done after window is shown
        # to prevent UI blocking (like winSTT.py does)
        print("  ⏸️  Workers will be initialized after window is shown...")
        
        # Create tray icon
        print("  🔔 Creating system tray icon...")
        self.tray_icon = QSystemTrayIcon(self)
        self.create_tray_icon()
        print("  ✅ System tray icon created")
        
        # Explicitly set central widget geometry to cover the entire window
        self.centralwidget.setGeometry(0, 0, self.width(), self.height())
        
        self.logger = logger      
        
        # Install the event filter (if not already done)
        print("  🎮 Installing event filter...")
        QApplication.instance().installEventFilter(self)
        print("  ✅ Event filter installed")
        print("  🎉 Window initialization complete!")

    # Import methods from window_methods
    open_settings = window_methods.open_settings
    init_workers_and_signals = window_methods.init_workers_and_signals
    init_listener = window_methods.init_listener
    init_llm_worker = window_methods.init_llm_worker
    handle_llm_error = window_methods.handle_llm_error
    handle_transcription = window_methods.handle_transcription
    display_message = window_methods.display_message
    create_tray_icon = window_methods.create_tray_icon
    show_window = window_methods.show_window
    close_app = window_methods.close_app
    tray_icon_activated = window_methods.tray_icon_activated
    open_files = window_methods.open_files
    get_key_name = window_methods.get_key_name
    keyPressEvent = window_methods.keyPressEvent
    keyReleaseEvent = window_methods.keyReleaseEvent
    eventFilter = window_methods.eventFilter
    showEvent = window_methods.showEvent
    changeEvent = window_methods.changeEvent
    resizeEvent = window_methods.resizeEvent
    dragEnterEvent = window_methods.dragEnterEvent
    dropEvent = window_methods.dropEvent
    process_media_files = window_methods.process_media_files
    process_next_file = window_methods.process_next_file
    transcribe_file = window_methods.transcribe_file
    transcribe_audio_data = window_methods.transcribe_audio_data
    transcription_finished = window_methods.transcription_finished
    transcription_error = window_methods.transcription_error
    format_time_srt = window_methods.format_time_srt
    # Add voice visualizer methods
    show_voice_visualizer = window_methods.show_voice_visualizer
    hide_voice_visualizer = window_methods.hide_voice_visualizer
    update_waveform = window_methods.update_waveform
    fade_in_instruction_text = window_methods.fade_in_instruction_text 
    scan_folder_for_media = window_methods.scan_folder_for_media
    is_supported_media_file = window_methods.is_supported_media_file
    is_audio_file = window_methods.is_audio_file
    is_video_file = window_methods.is_video_file
    convert_video_to_mp3 = window_methods.convert_video_to_mp3
    update_progress_safely = window_methods.update_progress_safely