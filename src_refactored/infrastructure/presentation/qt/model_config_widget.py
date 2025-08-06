"""Model Configuration Widget Component.

This module provides a reusable widget for model and quantization configuration
that integrates with domain services and follows DDD architecture principles.
"""


from PyQt6.QtCore import QSize, pyqtSignal
from PyQt6.QtGui import QFont, QIcon
from PyQt6.QtWidgets import (
    QComboBox,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from src_refactored.domain.settings.value_objects.model_configuration import (
    ModelConfiguration,
    ModelType,
    Quantization,
)
from src_refactored.infrastructure.common.resource_service import resource_path


class ModelConfigWidget(QGroupBox):
    """Model configuration widget component.
    
    This widget provides UI controls for model selection and quantization
    configuration with proper domain integration.
    """

    # Signals for model configuration changes
    model_changed = pyqtSignal(str)
    quantization_changed = pyqtSignal(str)
    model_reset = pyqtSignal()
    quantization_reset = pyqtSignal()
    download_started = pyqtSignal(str)  # Emitted when model download starts

    def __init__(self, parent=None):
        """Initialize the model configuration widget.
        
        Args:
            parent: Parent widget
        """
        super().__init__("Model Settings", parent)

        # Available models and their configurations
        self._available_models = [
            "whisper-turbo",
            "lite-whisper-turbo",
            "lite-whisper-turbo-fast",
        ]

        # Current configuration
        self._current_model = "whisper-turbo"
        self._current_quantization = "Full"

        # Default configuration
        self._default_model = "whisper-turbo"
        self._default_quantization = "Full"

        # UI components
        self.model_combo: QComboBox | None = None
        self.quant_combo: QComboBox | None = None
        self.model_reset_btn: QPushButton | None = None
        self.quant_reset_btn: QPushButton | None = None
        self.progress_placeholder: QWidget | None = None

        # Setup UI
        self._setup_ui()
        self._setup_connections()

    def _setup_ui(self):
        """Setup the user interface."""
        # Apply styling
        self._apply_styling()

        # Create main layout
        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        # Create model selection section
        self._create_model_selection(layout)

        # Create divider
        self._create_divider(layout)

        # Create quantization selection section
        self._create_quantization_selection(layout)

        # Create progress placeholder
        self._create_progress_placeholder(layout)

    def _apply_styling(self):
        """Apply dark theme styling to the widget."""
        self.setStyleSheet("""
            QGroupBox {
                background-color: rgb(18, 25, 31);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 5px;
                margin-top: 10px;
                font-weight: bold;
                color: rgb(144, 164, 174);
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px 0 5px;
            }
        """)

    def _create_model_selection(self, layout: QVBoxLayout,
    ):
        """Create the model selection section.
        
        Args:
            layout: Parent layout to add the section to
        """
        model_widget = QWidget()
        model_row_layout = QHBoxLayout(model_widget)
        model_row_layout.setContentsMargins(0, 0, 0, 0)

        # Model label
        model_label = QLabel("Model:")
        model_label.setFont(QFont())
        model_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Model combo box
        self.model_combo = QComboBox()
        self.model_combo.addItems(self._available_models)
        self.model_combo.setCurrentText(self._current_model)
        self.model_combo.setEnabled(True)
        self.model_combo.setStyleSheet("""
            QComboBox {
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129);
                padding: 5px;
            }
            QComboBox QAbstractItemView {
                background-color: rgb(8, 11, 14);
                color: rgb(163, 190, 203);
            }
        """)

        # Model reset button
        self.model_reset_btn = self._create_reset_button("Reset to default model")

        # Add to layout
        model_row_layout.addWidget(model_label)
        model_row_layout.addWidget(self.model_combo, 1)
        model_row_layout.addWidget(self.model_reset_btn)

        layout.addWidget(model_widget)

    def _create_divider(self, layout: QVBoxLayout,
    ):
        """Create a divider line.
        
        Args:
            layout: Parent layout to add the divider to
        """
        divider = QFrame()
        divider.setFrameShape(QFrame.Shape.HLine)
        divider.setFixedHeight(1)
        divider.setStyleSheet("""
            QFrame {
                background-color: rgb(78, 106, 129);
                border: none;
            }
        """)
        layout.addWidget(divider)

    def _create_quantization_selection(self, layout: QVBoxLayout,
    ):
        """Create the quantization selection section.
        
        Args:
            layout: Parent layout to add the section to
        """
        quant_widget = QWidget()
        quant_row_layout = QHBoxLayout(quant_widget)
        quant_row_layout.setContentsMargins(0, 0, 0, 0)

        # Quantization label
        quant_label = QLabel("Quantization:")
        quant_label.setFont(QFont())
        quant_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Quantization combo box
        self.quant_combo = QComboBox()
        self._update_quantization_options()
        self.quant_combo.setCurrentText(self._current_quantization)
        self.quant_combo.setStyleSheet("""
            QComboBox {
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border-style: outset;
                border-radius: 3px;
                border-width: 1px;
                border-color: rgb(78, 106, 129);
                padding: 5px;
            }
            QComboBox QAbstractItemView {
                background-color: rgb(8, 11, 14);
                color: rgb(163, 190, 203);
            }
        """)

        # Quantization reset button
        self.quant_reset_btn = self._create_reset_button("Reset to default quantization")

        # Add to layout
        quant_row_layout.addWidget(quant_label)
        quant_row_layout.addWidget(self.quant_combo, 1)
        quant_row_layout.addWidget(self.quant_reset_btn)

        layout.addWidget(quant_widget)

    def _create_progress_placeholder(self, layout: QVBoxLayout,
    ):
        """Create a placeholder for progress bar during model downloads.
        
        Args:
            layout: Parent layout to add the placeholder to
        """
        self.progress_placeholder = QWidget()
        self.progress_placeholder.setFixedHeight(0)  # Start collapsed
        self.progress_placeholder.setMaximumHeight(20)  # Allow expansion

        progress_layout = QHBoxLayout(self.progress_placeholder)
        progress_layout.setContentsMargins(0, 0, 0, 0)
        progress_layout.setSpacing(0)

        layout.addWidget(self.progress_placeholder)

    def _create_reset_button(self, tooltip: str,
    ) -> QPushButton:
        """Create a standardized reset button.
        
        Args:
            tooltip: Tooltip text for the button
            
        Returns:
            Configured reset button
        """
        reset_btn = QPushButton()
        reset_btn.setToolTip(tooltip)
        reset_btn.setIcon(QIcon(resource_path("resources/Command-Reset-256.png")))
        reset_btn.setIconSize(QSize(16, 16))
        reset_btn.setFixedSize(17, 30)
        reset_btn.setStyleSheet("""
            QPushButton {
                background-color: rgb(54, 71, 84);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: rgb(78, 106, 129);
            }
        """)
        return reset_btn

    def _setup_connections(self):
        """Setup signal connections."""
        if self.model_combo:
            self.model_combo.currentTextChanged.connect(self._on_model_changed)

        if self.quant_combo:
            self.quant_combo.currentTextChanged.connect(self._on_quantization_changed)

        if self.model_reset_btn:
            self.model_reset_btn.clicked.connect(self._on_model_reset)

        if self.quant_reset_btn:
            self.quant_reset_btn.clicked.connect(self._on_quantization_reset)

    def _update_quantization_options(self):
        """Update quantization options based on current model."""
        if not self.quant_combo:
            return

        self.quant_combo.clear()

        if "lite" in self._current_model:
            # Lite models only support full precision
            self.quant_combo.addItem("Full")
            self.quant_combo.setEnabled(False)
        else:
            # Standard models support both full and quantized
            self.quant_combo.addItems(["Full", "Quantized"])
            self.quant_combo.setEnabled(True)

    def _on_model_changed(self):
        """Handle model selection changes."""
        if not self.model_combo:
            return

        new_model = self.model_combo.currentText()
        if new_model != self._current_model:
            self._current_model = new_model

            # Update quantization options
            self._update_quantization_options()

            # Reset quantization to Full for lite models
            if "lite" in new_model:
                self._current_quantization = "Full"
                if self.quant_combo:
                    self.quant_combo.setCurrentText("Full")

            # Emit signals
            self.model_changed.emit(new_model)

            # Check if download is needed
            if self._requires_download(new_model):
                self.download_started.emit(new_model)

    def _on_quantization_changed(self):
        """Handle quantization selection changes."""
        if not self.quant_combo:
            return

        new_quantization = self.quant_combo.currentText()
        if new_quantization != self._current_quantization:
            self._current_quantization = new_quantization
            self.quantization_changed.emit(new_quantization)

    def _on_model_reset(self):
        """Handle model reset button click."""
        if self.model_combo:
            self.model_combo.setCurrentText(self._default_model)
            self.model_reset.emit()

    def _on_quantization_reset(self):
        """Handle quantization reset button click."""
        if self.quant_combo:
            self.quant_combo.setCurrentText(self._default_quantization)
            self.quantization_reset.emit()

    def _requires_download(self, model: str,
    ) -> bool:
        """Check if a model requires downloading.
        
        Args:
            model: Model name to check
            
        Returns:
            True if download is required, False otherwise
        """
        # This would typically check if the model files exist locally
        # For now, assume all model changes require download
        return True

    # Public interface methods
    def set_model(self, model: str,
    ):
        """Set the current model.
        
        Args:
            model: Model name to set
        """
        if model in self._available_models:
            self._current_model = model
            if self.model_combo:
                self.model_combo.setCurrentText(model)
                self._update_quantization_options()

    def set_quantization(self, quantization: str,
    ):
        """Set the current quantization.
        
        Args:
            quantization: Quantization type to set
        """
        self._current_quantization = quantization
        if self.quant_combo:
            self.quant_combo.setCurrentText(quantization)

    def get_model(self) -> str:
        """Get the currently selected model.
        
        Returns:
            Current model name
        """
        return self._current_model

    def get_quantization(self) -> str:
        """Get the currently selected quantization.
        
        Returns:
            Current quantization type
        """
        return self._current_quantization

    def get_model_configuration(self) -> ModelConfiguration:
        """Get the current model configuration as a domain object.
        
        Returns:
            ModelConfiguration domain object
        """
        return ModelConfiguration(
            model_type=ModelType.from_string(self._current_model),
            quantization=Quantization.from_string(self._current_quantization),
            use_gpu=True,  # Default to GPU usage
        )

    def set_model_configuration(self, config: ModelConfiguration,
    ):
        """Set the model configuration from a domain object.
        
        Args:
            config: ModelConfiguration domain object
        """
        self.set_model(config.model_type.value)
        self.set_quantization(config.quantization.value)

    def reset_to_defaults(self):
        """Reset both model and quantization to default values."""
        self.set_model(self._default_model)
        self.set_quantization(self._default_quantization)

    def set_enabled(self, enabled: bool,
    ):
        """Enable or disable the widget.
        
        Args:
            enabled: Whether to enable the widget
        """
        if self.model_combo:
            self.model_combo.setEnabled(enabled)
        if self.quant_combo:
            self.quant_combo.setEnabled(enabled and "lite" not in self._current_model)
        if self.model_reset_btn:
            self.model_reset_btn.setEnabled(enabled)
        if self.quant_reset_btn:
            self.quant_reset_btn.setEnabled(enabled)

    def get_available_models(self) -> list[str]:
        """Get the list of available models.
        
        Returns:
            List of available model names
        """
        return self._available_models.copy()

    def add_model(self, model: str,
    ):
        """Add a new model to the available models list.
        
        Args:
            model: Model name to add
        """
        if model not in self._available_models:
            self._available_models.append(model)
            if self.model_combo:
                self.model_combo.addItem(model)

    def remove_model(self, model: str,
    ):
        """Remove a model from the available models list.
        
        Args:
            model: Model name to remove
        """
        if model in self._available_models and model != self._current_model:
            self._available_models.remove(model)
            if self.model_combo:
                index = self.model_combo.findText(model)
                if index >= 0:
                    self.model_combo.removeItem(index)

    def show_progress_placeholder(self):
        """Show the progress placeholder for download indication."""
        if self.progress_placeholder:
            self.progress_placeholder.setFixedHeight(20)

    def hide_progress_placeholder(self):
        """Hide the progress placeholder."""
        if self.progress_placeholder:
            self.progress_placeholder.setFixedHeight(0,
    )