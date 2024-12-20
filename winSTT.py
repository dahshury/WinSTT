# Form implementation generated from reading ui file 'untitled.ui'
#
# Created by: PyQt6 UI code generator 6.6.1
#
# WARNING: Any manual changes made to this file will be lost when pyuic6 is
# run again.  Do not edit this file unless you know what you are doing.

#! Fix: Reduce size
#? Add: live transcription, live system audio transcription with diarization (live subtitles), textEdit color based on activity, downloading background animation

# Disable terminal flashing
import subprocess
from unittest.mock import patch

# Save the original Popen method
original_popen = subprocess.Popen

def suppress_subprocess_call(*args, **kwargs):
    # Suppress the console window
    CREATE_NO_WINDOW = 0x08000000
    kwargs['creationflags'] = kwargs.get('creationflags', 0) | CREATE_NO_WINDOW
    return original_popen(*args, **kwargs)

def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = (os.path.dirname(os.path.abspath(__file__)))

    return os.path.join(base_path, relative_path)

# Suppression patch
with patch("subprocess.Popen", side_effect=suppress_subprocess_call):
    from PyQt6 import QtCore, QtGui
    from PyQt6.QtWidgets import QSystemTrayIcon, QMenu, QSizePolicy, QWidget, QFrame, QLabel, QProgressBar, QCheckBox, QPushButton, QTextEdit, QMessageBox, QMainWindow, QGraphicsView, QComboBox, QApplication, QGraphicsOpacityEffect
    from PyQt6.QtCore import QObject, pyqtSignal, QThread, QTimer, QPropertyAnimation, QTimer, QEasingCurve, Qt, QParallelAnimationGroup
    from PyQt6.QtGui import QAction, QIcon
    import sys
    import os
    import onnxruntime as ort
    import gc
    from utils.transcribe import WhisperONNXTranscriber, VaDetector
    from utils.listener import AudioToText
    from logger import setup_logger

    logger = setup_logger()

    class VadWorker(QObject):
        initialized = pyqtSignal()
        error = pyqtSignal(str)
        
        def __init__(self):
            super().__init__()
            self.status = False

        def run(self):
            try:
                self.vad = VaDetector()
                self.initialized.emit()
                self.toggle_status()
            except Exception as e:
                self.error.emit(f"Failed to initialize VAD: {e}")
                logger.debug(f"Failed to initialize VAD: {e}")
                
        def toggle_status(self):
            self.status = True if self.status==False else False
            
    class ModelWorker(QObject):
        initialized = pyqtSignal()
        error = pyqtSignal(str)
        display_message_signal = pyqtSignal(object, object, object, object, object)# txt=None, filename=None, percentage=None, hold=False, reset=None

        def __init__(self, quantization=None):
            super().__init__()
            self.quantization = quantization
            self.status=False

        def run(self):
            try:
                self.model = WhisperONNXTranscriber(q=self.quantization, display_message_signal=self.display_message_signal)
                self.initialized.emit()
                self.toggle_status()
            except Exception as e:
                self.error.emit(f"Failed to initialize model: {e}")
                logger.debug(f"Failed to initialize model: {e}")
                
        def toggle_status(self):
            self.status = True if self.status==False else False
            
    class ListenerWorker(QObject):
        transcription_ready = pyqtSignal(str)
        error = pyqtSignal(str)
        initialized = pyqtSignal()
        display_message_signal = pyqtSignal(object, object, object, object, object)# txt=None, filename=None, percentage=None, hold=False, reset=None
        terminate_signal = pyqtSignal()
        
        def __init__(self, model, vad, rec_key):
            super().__init__()
            self._running = None
            self.listener = AudioToText(model, vad, error_callback=self.display_message_signal)
            self.rec_key = rec_key

        def run(self,):
            try:
                self.listener.capture_keys(self.rec_key)
                self.initialized.emit()
                self._running = True
                while self._running:
                    QThread.msleep(10)
            except Exception as e:
                self.error.emit(f"Listener Error: {e}")
                logger.debug(f"Listener Error: {e}")
            finally:
                self.listener.shutdown()
                del self.listener
                gc.collect()
        def stop(self):
            self._running = False
            
    class Ui_MainWindow(object):
        def setupUi(self, MainWindow):
            self.script_path = (os.path.dirname(os.path.abspath(__file__)))
            # print(self.script_path)
            self.acc = "CUDAExecutionProvider" in ort.get_available_providers()
            MainWindow.setObjectName("MainWindow")
            MainWindow.setEnabled(True)
            MainWindow.setFixedSize(400, 300)
            
            icon = QIcon(resource_path("./media/Windows 1 Theta.png"))
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
            self.line = QFrame(parent=self.centralwidget)
            self.line.setStyleSheet("color: rgb(144, 164, 174);")
            self.line.setGeometry(QtCore.QRect(80, 190, 241, 20))
            self.line.setFrameShape(QFrame.Shape.HLine)
            self.line.setFrameShadow(QFrame.Shadow.Sunken)
            self.line.setObjectName("line")
            self.checkBox = QCheckBox(parent=self.centralwidget)
            self.checkBox.setGeometry(QtCore.QRect(10, 269, 180, 31))
            font = QtGui.QFont()
            font.setFamily("Roboto")
            self.checkBox.setFont(font)
            self.checkBox.setAcceptDrops(True)
            self.checkBox.setObjectName("checkBox")
            self.checkBox.setStyleSheet("""QCheckBox {
                                        border-style: outset;
                                        border-radius: 3px;
                                        color: rgb(144, 164, 174);
                                    }
                                    QCheckBox::indicator {
                                        background-color: rgb(54, 71, 84);
                                        border-width: 1px;
                                        border-color: rgb(78, 106, 129);
                                    }
                                    QCheckBox::indicator:checked {
                                        background-color: rgb(20, 89, 134);
                                    }
                                    """)
            self.label = QLabel(parent=self.centralwidget)
            self.label.setGeometry(QtCore.QRect(262, 269, 161, 31))
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
            self.label_3.setGeometry(QtCore.QRect(17, 200, 370, 50))
            self.label_3.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            font = QtGui.QFont()
            font.setFamily("Input")
            font.setPointSize(10)
            self.label_3.setFont(font)
            self.label_3.setObjectName("label_3")
            self.progressBar = QProgressBar(parent=self.centralwidget)
            self.progressBar.setGeometry(QtCore.QRect(60, 240, 290, 14))
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
            self.graphicsView_2.setGeometry(QtCore.QRect(0, 270, 411, 31))
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
            self.label_2.setPixmap(QtGui.QPixmap(resource_path("./media/Windows 1 Theta.png")))
            self.label_2.setScaledContents(True)
            self.label_2.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            self.label_2.setObjectName("label_2")
            self.pushButton = QPushButton(parent=self.centralwidget)
            self.pushButton.setGeometry(QtCore.QRect(230, 70, 101, 31))
            self.pushButton.setObjectName("pushButton")
            self.pushButton.setStyleSheet("QPushButton {background-color: rgb(54, 71, 84); color: rgb(144, 164, 174); border-style: outset;  border-radius: 3px; border-width: 1px; border-color: rgb(78, 106, 129)}")

            self.textEdit = QTextEdit(parent=self.centralwidget)
            self.textEdit.setGeometry(QtCore.QRect(70, 70, 110, 31))
            self.textEdit.setLineWidth(0)
            self.textEdit.setText('CTRL+ALT+A')
            self.textEdit.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
            self.textEdit.setReadOnly(True)
            self.textEdit.setObjectName("Current Key")
            self.textEdit.setStyleSheet("""
                                        QTextEdit {background-color: rgb(54, 71, 84);
                                        color: rgb(144, 164, 174); border-style: outset;
                                        border-radius: 3px; border-width: 1px;
                                        border-color: rgb(78, 106, 129)}
                                        """)
            self.comboBox = QComboBox(parent=self.centralwidget)
            self.comboBox.setGeometry(QtCore.QRect(70, 140, 111, 31))
            self.comboBox.setObjectName("Model")
            self.comboBox.addItem("")
            self.comboBox.setStyleSheet("""
                QComboBox {
                    background-color: rgb(54, 71, 84);
                    color: rgb(144, 164, 174);
                    placeholder-text-color: rgb(173, 190, 203);
                    border-style: outset;
                    border-radius: 3px;
                    border-width: 1px;
                    border-color: rgb(78, 106, 129);
                    color: rgb(163, 190, 203);
                }

                QComboBox QAbstractItemView {
                    background-color: rgb(8, 11, 14);
                }
            """)
            self.comboBox_2 = QComboBox(parent=self.centralwidget)
            self.comboBox_2.setGeometry(QtCore.QRect(230, 140, 101, 31))
            self.comboBox_2.setObjectName("Quantization")
            self.comboBox_2.addItem("")
            self.comboBox_2.addItem("")
            self.comboBox_2.setStyleSheet("""
                QComboBox {
                    background-color: rgb(54, 71, 84);
                    color: rgb(144, 164, 174);
                    placeholder-text-color: rgb(173, 190, 203);
                    border-style: outset;
                    border-radius: 3px;
                    border-width: 1px;
                    border-color: rgb(78, 106, 129);
                    color: rgb(163, 190, 203);
                }

                QComboBox QAbstractItemView {
                    background-color: rgb(8, 11, 14);
                }
            """)
            self.label_4 = QLabel(parent=self.centralwidget)
            self.label_4.setGeometry(QtCore.QRect(360, 270, 31, 31))
            self.label_4.setText("")
            self.label_4.setPixmap(QtGui.QPixmap(resource_path("./media/switch-on.png") if self.acc else resource_path("./media/switch-off.png")))
            self.label_4.setScaledContents(True)
            self.label_4.setObjectName("label_4")
            self.label_5 = QLabel(parent=self.centralwidget)
            self.label_5.setGeometry(QtCore.QRect(0, -5, 401, 51))
            self.label_5.setText("")
            self.label_5.setPixmap(QtGui.QPixmap(resource_path("./media/Untitled-1.png")))
            self.label_5.setScaledContents(True)
            self.label_5.setObjectName("label_5")
            self.label_5.raise_()
            self.graphicsView_2.raise_()
            self.line.raise_()
            self.checkBox.raise_()
            self.label.raise_()
            self.WinSTT.raise_()
            self.label_3.raise_()
            self.progressBar.raise_()
            self.label_2.raise_()
            self.pushButton.raise_()
            self.textEdit.raise_()
            self.comboBox.raise_()
            self.comboBox_2.raise_()
            self.label_4.raise_()
            MainWindow.setCentralWidget(self.centralwidget)
            self.retranslateUi(MainWindow)

        def retranslateUi(self, MainWindow):
            _translate = QtCore.QCoreApplication.translate
            MainWindow.setWindowTitle(_translate("MainWindow", "WinSTT"))
            self.checkBox.setText(_translate("MainWindow", "Recording sound (Drag/Drop)"))
            self.checkBox.setChecked(True)
            self.label.setText(_translate("MainWindow", "H/W Acceleration:"))
            self.WinSTT.setText(_translate("MainWindow", "STT"))
            self.label_3.setText(_translate("MainWindow", ""))
            self.pushButton.setText(_translate("MainWindow", "Change Rec Key"))
            self.comboBox.setItemText(0, _translate("MainWindow", "Whisper-Turbo"))
            self.comboBox.setCurrentText("Whisper-Turbo") #! Change when adding new models
            self.comboBox.setEnabled(True if self.acc else False)
            self.comboBox_2.setItemText(0, _translate("MainWindow", "Full"))
            self.comboBox_2.setItemText(1, _translate("MainWindow", "Quantized"))
                
    class Window(QMainWindow, Ui_MainWindow):
        def __init__(self):
            super().__init__()
            self.setupUi(self)
            
            
            self.start_sound = os.path.join(resource_path("./media/splash.mp3"))
            self.pressed_keys = set()
            self.record_key_toggle = False
            
            self.pushButton.clicked.connect(self.toggle_and_set)

            self.checkBox.clicked.connect(self.toggle_sound)
                    
            self.minimize_counter = 0
            self.comboBox_2.setCurrentText("Full" if self.acc else "Quantized")
            self.comboBox_2.currentIndexChanged.connect(self.init_workers_and_signals)
            self.comboBox.currentIndexChanged.connect(self.init_workers_and_signals)

            # Initialize threads
            self.vad_thread = QThread()
            self.model_thread = QThread()
            self.listener_thread = QThread()
            self.started_listener = False
            
            self.init_workers_and_signals()

            self.create_tray_icon()
            self.logger = setup_logger()      
            
        def dragEnterEvent(self, event):
            mime_data = event.mimeData()

            # Check if the dragged data contains URLs
            if mime_data.hasUrls():
                url = mime_data.urls()[0].toLocalFile()
                if os.path.splitext(url)[-1] in ['.mp3', '.wav']:
                    event.acceptProposedAction()
                else:
                    QMessageBox.warning(self, "Invalid File", "Please drop a .mp3 or .wav file.", QMessageBox.StandardButton.Ok)
                    
        def dropEvent(self, event):
            mime_data = event.mimeData()

            # Check if the dragged data contains URLs
            if mime_data.hasUrls():
                url = mime_data.urls()[0]
                file_path = url.toLocalFile()
                self.start_sound = url
                self.listener_worker.listener.start_sound = self.start_sound

        def keyPressEvent(self, event: QtGui.QKeyEvent):
            if self.record_key_toggle:
                event.accept()
                self.textEdit.setReadOnly(False)
                key_text = self.get_key_name(event)
                self.pressed_keys.add(key_text)
                self.combination = "+".join(sorted(self.pressed_keys))
                self.textEdit.setText(self.combination)
                self.textEdit.setReadOnly(True)
                self.textEdit.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
                
            QWidget.keyPressEvent(self, event)
                
        def keyReleaseEvent(self, event: QtGui.QKeyEvent):
            if self.record_key_toggle:
                event.accept()
                self.textEdit.setReadOnly(False)
                key_text = self.get_key_name(event)
                self.pressed_keys.discard(key_text)
                if len(self.pressed_keys)>0:
                    self.combination = "+".join(sorted(self.pressed_keys))
                    self.textEdit.setText(self.combination)    
                                
                self.textEdit.setReadOnly(True)
                self.textEdit.setAlignment(QtCore.Qt.AlignmentFlag.AlignCenter)
                QWidget.keyReleaseEvent(self, event)
                
        def get_key_name(self, event: QtGui.QKeyEvent):
            """Return the name of the key."""
            key = event.key()
            
            # Handle modifier keys
            if key == Qt.Key.Key_Control:
                return "Ctrl"
            elif key == Qt.Key.Key_Alt:
                return "Alt"
            elif key == Qt.Key.Key_Shift:
                return "Shift"
            elif key == Qt.Key.Key_Meta:
                return "Meta"
            else:
                # Handle regular keys using key()
                key_text = QtGui.QKeySequence(key).toString()
                if key_text:
                    return key_text
                return f"Key_{key}"
            
        def create_tray_icon(self):
            self.tray_icon = QSystemTrayIcon(self)
            self.tray_icon.setIcon(QIcon(resource_path("./media/Windows 1 Theta.png")))

            show_action = QAction("Show", self)
            close_action = QAction("Exit", self)
            show_action.triggered.connect(self.show_window)
            close_action.triggered.connect(self.close_app)
            tray_menu = QMenu()
            tray_menu.addAction(show_action)
            tray_menu.addAction(close_action)

            self.tray_icon.setContextMenu(tray_menu)
            self.tray_icon.setVisible(True)
            self.tray_icon.show()
            self.tray_icon.activated.connect(self.tray_icon_activated)

        def close_app(self):
            self.tray_icon.hide()
            QtCore.QCoreApplication.quit()
            
        def tray_icon_activated(self, reason):
            if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
                self.show_window()

        def show_window(self):
            self.showNormal()
            self.activateWindow()
            
        def changeEvent(self, event):
            if event.type() == QtCore.QEvent.Type.WindowStateChange:
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
                            3000
                        )
                elif event.oldState() & Qt.WindowState.WindowMinimized:
                    # Restore the window and show it in the taskbar
                    self.show()
                super().changeEvent(event)
                
        def toggle_sound(self):
            if self.checkBox.isChecked():
                self.self.listener_worker.listener.start_sound = self.start_sound
            else:
                self.self.listener_worker.listener.start_sound = ""
                
        def toggle_and_set(self):
            if not self.record_key_toggle:
                self.record_key_toggle = True
                self.pushButton.setText("Stop")
            else:
                self.record_key_toggle = False
                if len(self.textEdit.toPlainText())>0:
                    self.listener_worker.listener.capture_keys(self.textEdit.toPlainText().lower())
                
                self.pressed_keys = set()
                self.pushButton.setText("Record Key")
                
        def display_message(self, txt=None, filename=None, percentage=None, hold=None, reset=None):
            # Create opacity effects if they don't exist
            if not hasattr(self, 'label_opacity_effect'):
                self.label_opacity_effect = QGraphicsOpacityEffect(self.label_3)
                self.label_3.setGraphicsEffect(self.label_opacity_effect)
            
            if not hasattr(self, 'progress_opacity_effect'):
                self.progress_opacity_effect = QGraphicsOpacityEffect(self.progressBar)
                self.progressBar.setGraphicsEffect(self.progress_opacity_effect)

            # Handle text display
            if txt:
                # Reset opacity
                self.label_opacity_effect.setOpacity(1.0)
                self.label_3.setText(txt)
                # Create fade out animation
                self.fade_out = QPropertyAnimation(self.label_opacity_effect, b"opacity")
                self.fade_out.setDuration(3000)  # 3 second animation
                self.fade_out.setStartValue(1.0)
                self.fade_out.setEndValue(0.0)
                self.fade_out.setEasingCurve(QEasingCurve.Type.InOutQuad)
                
                # Start fade out after 5 seconds
                QTimer.singleShot(5000, self.fade_out.start)
                
                # Clear text after animation
                self.fade_out.finished.connect(lambda: self.label_3.setText(""))
                
            elif filename:
                self.label_3.setText(f"Downloading {filename}...")
                self.label_opacity_effect.setOpacity(1.0)
            
            # Handle button states
            if hold:
                self.pushButton.setEnabled(False)
                self.textEdit.setEnabled(False)
                self.comboBox.setEnabled(False)
                self.comboBox_2.setEnabled(False)
            
            if reset:
                self.pushButton.setEnabled(True)
                self.textEdit.setEnabled(True)
                self.comboBox_2.setEnabled(True)
                
                # Create fade out animations for both elements
                self.fade_out_label = QPropertyAnimation(self.label_opacity_effect, b"opacity")
                self.fade_out_label.setDuration(3000)
                self.fade_out_label.setStartValue(1.0)
                self.fade_out_label.setEndValue(0.0)
                
                self.fade_out_progress = QPropertyAnimation(self.progress_opacity_effect, b"opacity")
                self.fade_out_progress.setDuration(3000)
                self.fade_out_progress.setStartValue(1.0)
                self.fade_out_progress.setEndValue(0.0)
                
                # Create animation group to run both animations together
                self.animation_group = QParallelAnimationGroup()
                self.animation_group.addAnimation(self.fade_out_label)
                self.animation_group.addAnimation(self.fade_out_progress)
                
                # Start animations
                self.animation_group.start()
                
                # Clean up after animations complete
                def cleanup():
                    self.label_3.setText("")
                    self.progressBar.setVisible(False)
                    self.progressBar.setProperty("value", 0)
                    # Reset opacities to 1.0 for next time
                    self.label_opacity_effect.setOpacity(1.0)
                    self.progress_opacity_effect.setOpacity(1.0)
                
                self.animation_group.finished.connect(cleanup)
            
            if percentage is not None:
                if not self.progressBar.isVisible():
                    self.progressBar.setVisible(True)
                    self.progress_opacity_effect.setOpacity(1.0)
                
                self.progressBar.setProperty("value", percentage)
                
                # If percentage reaches 100%, start fade out animation
                if percentage >= 100:
                    QTimer.singleShot(1000, lambda: self.display_message(reset=True))
                    
        def init_workers_and_signals(self):
            # Initialize VAD worker and thread
            if not hasattr(self, "vad_worker"):
                self.vad_worker = VadWorker()
                self.vad_worker.moveToThread(self.vad_thread)
                self.vad_worker.initialized.connect(lambda: self.display_message(txt="VAD Initialized"))
                self.vad_worker.initialized.connect(lambda: self.init_listener())
                self.vad_worker.error.connect(lambda error_message: self.display_message(txt=f"Error: {error_message}"))
                self.vad_thread.started.connect(self.vad_worker.run)
                self.vad_thread.start()

            # Initialize Model worker and thread
            if hasattr(self, "model_worker"):
                self.model_thread.quit()
                self.model_thread.wait()
                self.model_worker.model.clear_sessions()
                self.model_worker.deleteLater()
                self.model_thread.deleteLater()
                self.model_thread = QThread()
            self.model_worker = ModelWorker(self.comboBox_2.currentText())
            self.model_worker.moveToThread(self.model_thread)
            self.model_worker.display_message_signal.connect(lambda txt, filename, percentage, hold, reset: self.display_message(txt, filename, percentage, hold, reset))
            self.model_worker.initialized.connect(lambda: self.display_message(txt="Model Initialized"))
            self.model_worker.initialized.connect(lambda: self.init_listener())
            self.model_worker.error.connect(lambda error_message: self.display_message(txt=f"Error: {error_message}"))
            self.model_thread.started.connect(self.model_worker.run)
            self.model_thread.start()
            
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
                self.listener_worker = ListenerWorker(self.model_worker.model, self.vad_worker.vad, self.textEdit.toPlainText())
                self.listener_worker.moveToThread(self.listener_thread)
                self.listener_worker.transcription_ready.connect(self.handle_transcription)
                self.listener_worker.error.connect(lambda error_message: self.display_message(txt=f"Error: {error_message}"))
                self.listener_worker.initialized.connect(lambda: self.display_message(txt="Listener Initialized"))
                self.listener_worker.display_message_signal.connect(lambda txt, filename, percentage, hold, reset: self.display_message(txt, filename, percentage, hold, reset))
                self.listener_thread.started.connect(self.listener_worker.run) # self.textEdit.toPlainText()
                self.listener_thread.start()

        def handle_transcription(self, transcription):
            self.display_message(txt=f"{transcription}")
            
        def show_notification(self):
            self.minimize_counter +=1
        # Only show notification when the window is minimized the first time
            if self.minimize_counter == 1:
                self.tray_icon.showMessage(
                    "App Minimized",
                    "The app is minimized, and still running in the background. Right click on icon to exit",
                    QSystemTrayIcon.MessageIcon.Information,
                    2000
                ) 

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    app.setWindowIcon(QIcon(resource_path("media/Windows 1 Theta.png")))
    window = Window()
    window.show()
    sys.exit(app.exec())