"""LLM Configuration Widget Component.

This module provides a reusable widget for LLM configuration
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
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from src.domain.settings.value_objects.llm_configuration import LLMConfiguration
from src.domain.settings.value_objects.model_configuration import Quantization
from src.infrastructure.common.resource_service import resource_path
from src.presentation.qt.toggle_switch_widget import ToggleSwitch


class LLMConfigWidget(QGroupBox):
    """LLM configuration widget component.
    
    This widget provides UI controls for LLM configuration including
    enable/disable toggle, model selection, quantization, and system prompt.
    """

    # Signals for LLM configuration changes
    llm_enabled_changed = pyqtSignal(bool)
    llm_model_changed = pyqtSignal(str)
    llm_quantization_changed = pyqtSignal(str)
    llm_prompt_changed = pyqtSignal(str)
    llm_reset = pyqtSignal()

    def __init__(self, parent=None):
        """Initialize the LLM configuration widget.
        
        Args:
            parent: Parent widget
        """
        super().__init__("LLM Settings", parent)

        # Available LLM models
        self._available_models = [
            "gemma-3-1b-it",
            "llama-3.2-1b-instruct",
            "phi-3.5-mini-instruct",
        ]

        # Current configuration
        self._current_enabled = False
        self._current_model = "gemma-3-1b-it"
        self._current_quantization = "Full"
        self._current_prompt = "You are a helpful assistant."

        # Default configuration
        self._default_enabled = False
        self._default_model = "gemma-3-1b-it"
        self._default_quantization = "Full"
        self._default_prompt = "You are a helpful assistant."

        # UI components
        self.enable_llm_toggle: ToggleSwitch | None = None
        self.llm_model_combo: QComboBox | None = None
        self.llm_quant_combo: QComboBox | None = None
        self.llm_prompt_textbox: QLineEdit | None = None
        self.llm_model_reset_btn: QPushButton | None = None
        self.llm_quant_reset_btn: QPushButton | None = None

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

        # Create LLM enable toggle section
        self._create_enable_toggle(layout)

        # Create divider
        self._create_divider(layout)

        # Create model selection section
        self._create_model_selection(layout)

        # Create divider
        self._create_divider(layout)

        # Create quantization selection section
        self._create_quantization_selection(layout)

        # Create divider
        self._create_divider(layout)

        # Create prompt configuration section
        self._create_prompt_configuration(layout)

        # Initialize control states
        self._update_control_states()

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

    def _create_enable_toggle(self, layout: QVBoxLayout,
    ):
        """Create the LLM enable toggle section.
        
        Args:
            layout: Parent layout to add the section to
        """
        toggle_widget = QWidget()
        toggle_layout = QHBoxLayout(toggle_widget)
        toggle_layout.setContentsMargins(0, 0, 0, 0)

        # Enable LLM label
        toggle_label = QLabel("Enable LLM Inference")
        toggle_label.setFont(QFont())
        toggle_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Enable LLM toggle switch
        self.enable_llm_toggle = ToggleSwitch()
        self.enable_llm_toggle.setChecked(self._current_enabled)

        # Add to layout
        toggle_layout.addWidget(toggle_label)
        toggle_layout.addStretch(1)
        toggle_layout.addWidget(self.enable_llm_toggle)

        layout.addWidget(toggle_widget)

    def _create_model_selection(self, layout: QVBoxLayout,
    ):
        """Create the LLM model selection section.
        
        Args:
            layout: Parent layout to add the section to
        """
        model_widget = QWidget()
        model_layout = QHBoxLayout(model_widget)
        model_layout.setContentsMargins(0, 0, 0, 0)

        # Model label
        model_label = QLabel("LLM Model:")
        model_label.setFont(QFont())
        model_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Model combo box
        self.llm_model_combo = QComboBox()
        self.llm_model_combo.addItems(self._available_models)
        self.llm_model_combo.setCurrentText(self._current_model)
        self.llm_model_combo.setEnabled(False)  # Initially disabled
        self.llm_model_combo.setStyleSheet("""
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
        self.llm_model_reset_btn = self._create_reset_button("Reset to default LLM model")

        # Add to layout
        model_layout.addWidget(model_label)
        model_layout.addWidget(self.llm_model_combo, 1)
        model_layout.addWidget(self.llm_model_reset_btn)

        layout.addWidget(model_widget)

    def _create_quantization_selection(self, layout: QVBoxLayout,
    ):
        """Create the LLM quantization selection section.
        
        Args:
            layout: Parent layout to add the section to
        """
        quant_widget = QWidget()
        quant_layout = QHBoxLayout(quant_widget)
        quant_layout.setContentsMargins(0, 0, 0, 0)

        # Quantization label
        quant_label = QLabel("LLM Quantization:")
        quant_label.setFont(QFont())
        quant_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Quantization combo box
        self.llm_quant_combo = QComboBox()
        self.llm_quant_combo.addItems(["Full", "Quantized"])
        self.llm_quant_combo.setCurrentText(self._current_quantization)
        self.llm_quant_combo.setEnabled(False)  # Initially disabled
        self.llm_quant_combo.setStyleSheet("""
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
        self.llm_quant_reset_btn = self._create_reset_button("Reset to default LLM quantization")

        # Add to layout
        quant_layout.addWidget(quant_label)
        quant_layout.addWidget(self.llm_quant_combo, 1)
        quant_layout.addWidget(self.llm_quant_reset_btn)

        layout.addWidget(quant_widget)

    def _create_prompt_configuration(self, layout: QVBoxLayout,
    ):
        """Create the system prompt configuration section.
        
        Args:
            layout: Parent layout to add the section to
        """
        prompt_widget = QWidget()
        prompt_layout = QHBoxLayout(prompt_widget)
        prompt_layout.setContentsMargins(0, 0, 0, 0)

        # Prompt label
        prompt_label = QLabel("System Prompt:")
        prompt_label.setFont(QFont())
        prompt_label.setStyleSheet("color: rgb(144, 164, 174);")

        # Prompt text box
        self.llm_prompt_textbox = QLineEdit()
        self.llm_prompt_textbox.setText(self._current_prompt)
        self.llm_prompt_textbox.setEnabled(False)  # Initially disabled
        self.llm_prompt_textbox.setStyleSheet("""
            QLineEdit {
                background-color: rgb(54, 71, 84);
                color: rgb(163, 190, 203);
                border: 1px solid rgb(78, 106, 129);
                border-radius: 3px;
                padding: 5px;
            }
        """)

        # Add to layout
        prompt_layout.addWidget(prompt_label)
        prompt_layout.addWidget(self.llm_prompt_textbox, 1)

        layout.addWidget(prompt_widget)

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
        reset_btn.setIcon(QIcon(resource_path("@resources/Command-Reset-256.png")))
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
        if self.enable_llm_toggle:
            self.enable_llm_toggle.valueChanged.connect(self._on_llm_enabled_changed)

        if self.llm_model_combo:
            self.llm_model_combo.currentTextChanged.connect(self._on_model_changed)

        if self.llm_quant_combo:
            self.llm_quant_combo.currentTextChanged.connect(self._on_quantization_changed)

        if self.llm_prompt_textbox:
            self.llm_prompt_textbox.textChanged.connect(self._on_prompt_changed)

        if self.llm_model_reset_btn:
            self.llm_model_reset_btn.clicked.connect(self._on_model_reset)

        if self.llm_quant_reset_btn:
            self.llm_quant_reset_btn.clicked.connect(self._on_quantization_reset)

    def _update_control_states(self):
        """Update the enabled state of controls based on LLM enabled state."""
        enabled = self._current_enabled

        if self.llm_model_combo:
            self.llm_model_combo.setEnabled(enabled)

        if self.llm_quant_combo:
            self.llm_quant_combo.setEnabled(enabled)

        if self.llm_prompt_textbox:
            self.llm_prompt_textbox.setEnabled(enabled)

        if self.llm_model_reset_btn:
            self.llm_model_reset_btn.setEnabled(enabled)

        if self.llm_quant_reset_btn:
            self.llm_quant_reset_btn.setEnabled(enabled)

    def _on_llm_enabled_changed(self):
        """Handle LLM enabled state changes."""
        if not self.enable_llm_toggle:
            return

        new_enabled = self.enable_llm_toggle.isChecked()
        if new_enabled != self._current_enabled:
            self._current_enabled = new_enabled
            self._update_control_states()
            self.llm_enabled_changed.emit(new_enabled)

    def _on_model_changed(self):
        """Handle LLM model selection changes."""
        if not self.llm_model_combo:
            return

        new_model = self.llm_model_combo.currentText()
        if new_model != self._current_model:
            self._current_model = new_model
            self.llm_model_changed.emit(new_model)

    def _on_quantization_changed(self):
        """Handle LLM quantization selection changes."""
        if not self.llm_quant_combo:
            return

        new_quantization = self.llm_quant_combo.currentText()
        if new_quantization != self._current_quantization:
            self._current_quantization = new_quantization
            self.llm_quantization_changed.emit(new_quantization)

    def _on_prompt_changed(self):
        """Handle system prompt changes."""
        if not self.llm_prompt_textbox:
            return

        new_prompt = self.llm_prompt_textbox.text()
        if new_prompt != self._current_prompt:
            self._current_prompt = new_prompt
            self.llm_prompt_changed.emit(new_prompt)

    def _on_model_reset(self):
        """Handle model reset button click."""
        if self.llm_model_combo:
            self.llm_model_combo.setCurrentText(self._default_model)

    def _on_quantization_reset(self):
        """Handle quantization reset button click."""
        if self.llm_quant_combo:
            self.llm_quant_combo.setCurrentText(self._default_quantization)

    # Public interface methods
    def set_llm_enabled(self, enabled: bool,
    ):
        """Set the LLM enabled state.
        
        Args:
            enabled: Whether LLM should be enabled
        """
        self._current_enabled = enabled
        if self.enable_llm_toggle:
            self.enable_llm_toggle.setChecked(enabled)
        self._update_control_states()

    def set_llm_model(self, model: str,
    ):
        """Set the current LLM model.
        
        Args:
            model: Model name to set
        """
        if model in self._available_models:
            self._current_model = model
            if self.llm_model_combo:
                self.llm_model_combo.setCurrentText(model)

    def set_llm_quantization(self, quantization: str,
    ):
        """Set the current LLM quantization.
        
        Args:
            quantization: Quantization type to set
        """
        self._current_quantization = quantization
        if self.llm_quant_combo:
            self.llm_quant_combo.setCurrentText(quantization)

    def set_llm_prompt(self, prompt: str,
    ):
        """Set the current system prompt.
        
        Args:
            prompt: System prompt to set
        """
        self._current_prompt = prompt
        if self.llm_prompt_textbox:
            self.llm_prompt_textbox.setText(prompt)

    def get_llm_enabled(self) -> bool:
        """Get the current LLM enabled state.
        
        Returns:
            Current LLM enabled state
        """
        return self._current_enabled

    def get_llm_model(self) -> str:
        """Get the currently selected LLM model.
        
        Returns:
            Current LLM model name
        """
        return self._current_model

    def get_llm_quantization(self) -> str:
        """Get the currently selected LLM quantization.
        
        Returns:
            Current LLM quantization type
        """
        return self._current_quantization

    def get_llm_prompt(self) -> str:
        """Get the current system prompt.
        
        Returns:
            Current system prompt
        """
        return self._current_prompt

    def get_llm_configuration(self) -> LLMConfiguration:
        """Get the current LLM configuration as a domain object.
        
        Returns:
            LLMConfiguration domain object
        """
        return LLMConfiguration(
            enabled=self._current_enabled,
            model_name=self._current_model,
            quantization=Quantization.from_string(self._current_quantization),
            system_prompt=self._current_prompt,
        )

    def set_llm_configuration(self, config: LLMConfiguration,
    ):
        """Set the LLM configuration from a domain object.
        
        Args:
            config: LLMConfiguration domain object
        """
        self.set_llm_enabled(config.enabled)
        self.set_llm_model(config.model_name)
        self.set_llm_quantization(config.quantization.value)
        self.set_llm_prompt(config.system_prompt)

    def reset_to_defaults(self):
        """Reset all LLM settings to default values."""
        self.set_llm_enabled(self._default_enabled)
        self.set_llm_model(self._default_model)
        self.set_llm_quantization(self._default_quantization)
        self.set_llm_prompt(self._default_prompt)
        self.llm_reset.emit()

    def set_enabled(self, enabled: bool,
    ):
        """Enable or disable the entire widget.
        
        Args:
            enabled: Whether to enable the widget
        """
        if self.enable_llm_toggle:
            self.enable_llm_toggle.setEnabled(enabled)

        # Only enable other controls if both widget is enabled and LLM is enabled
        controls_enabled = enabled and self._current_enabled

        if self.llm_model_combo:
            self.llm_model_combo.setEnabled(controls_enabled)
        if self.llm_quant_combo:
            self.llm_quant_combo.setEnabled(controls_enabled)
        if self.llm_prompt_textbox:
            self.llm_prompt_textbox.setEnabled(controls_enabled)
        if self.llm_model_reset_btn:
            self.llm_model_reset_btn.setEnabled(controls_enabled)
        if self.llm_quant_reset_btn:
            self.llm_quant_reset_btn.setEnabled(controls_enabled)

    def get_available_models(self) -> list[str]:
        """Get the list of available LLM models.
        
        Returns:
            List of available LLM model names
        """
        return self._available_models.copy()

    def add_model(self, model: str,
    ):
        """Add a new LLM model to the available models list.
        
        Args:
            model: Model name to add
        """
        if model not in self._available_models:
            self._available_models.append(model)
            if self.llm_model_combo:
                self.llm_model_combo.addItem(model)

    def remove_model(self, model: str,
    ):
        """Remove an LLM model from the available models list.
        
        Args:
            model: Model name to remove
        """
        if model in self._available_models and model != self._current_model:
            self._available_models.remove(model)
            if self.llm_model_combo:
                index = self.llm_model_combo.findText(model)
                if index >= 0:
                    self.llm_model_combo.removeItem(index)