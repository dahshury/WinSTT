"""Settings validator for validating settings data and constraints."""

from pathlib import Path
from typing import Any

from src_refactored.domain.transcription.value_objects import ProgressCallback


class ValidationError(Exception):
    """Exception raised when settings validation fails."""


class SettingsValidator:
    """Infrastructure service for validating settings data."""

    def __init__(self, progress_callback: ProgressCallback | None = None):
        """Initialize the settings validator.
        
        Args:
            progress_callback: Optional callback for progress updates
        """
        self.progress_callback = progress_callback
        self._validation_rules = self._get_default_validation_rules()

    def _get_default_validation_rules(self) -> dict[str, dict[str, Any]]:
        """Get default validation rules for settings.
        
        Returns:
            Dictionary containing validation rules
        """
        return {
            "selected_model": {
                "type": str,
                "allowed_values": ["whisper-turbo", "lite-whisper-turbo", "lite-whisper-turbo-fast"],
                "required": True,
            },
            "selected_quantization": {
                "type": str,
                "allowed_values": ["full", "quantized"],
                "required": True,
            },
            "enable_recording_sound": {
                "type": bool,
                "required": False,
                "default": True,
            },
            "start_sound": {
                "type": str,
                "validator": self._validate_audio_file_path,
                "required": False,
            },
            "current_output_srt": {
                "type": bool,
                "required": False,
                "default": False,
            },
            "rec_key": {
                "type": str,
                "validator": self._validate_hotkey,
                "required": False,
                "default": "F2",
            },
            "llm_enabled": {
                "type": bool,
                "required": False,
                "default": False,
            },
            "llm_model": {
                "type": str,
                "allowed_values": ["microsoft/DialoGPT-medium", "microsoft/DialoGPT-large"],
                "required": False,
            },
            "llm_quantization": {
                "type": str,
                "allowed_values": ["full", "quantized"],
                "required": False,
            },
        }

    def validate_settings(self, settings: dict[str, Any]) -> dict[str, list[str]]:
        """Validate settings against defined rules.
        
        Args:
            settings: Dictionary containing settings to validate
            
        Returns:
            Dictionary containing validation errors (empty if valid)
        """
        errors = {}

        if self.progress_callback:
            self.progress_callback(txt="Validating settings...")

        for key, rules in self._validation_rules.items():
            field_errors = self._validate_field(key, settings.get(key), rules)
            if field_errors:
                errors[key] = field_errors

        # Check for unknown settings
        unknown_keys = set(settings.keys()) - set(self._validation_rules.keys())
        if unknown_keys:
            errors["unknown_keys"] = [f"Unknown setting: {key}" for key in unknown_keys]

        if self.progress_callback:
            if errors:
                self.progress_callback(txt=f"Settings validation failed with {len(errors)} errors")
            else:
                self.progress_callback(txt="Settings validation passed")

        return errors

    def _validate_field(self, key: str, value: Any, rules: dict[str, Any]) -> list[str]:
        """Validate a single field against its rules.
        
        Args:
            key: Field name
            value: Field value
            rules: Validation rules for the field
            
        Returns:
            List of validation error messages
        """
        errors = []

        # Check if required field is missing
        if rules.get("required", False) and value is None:
            errors.append(f"{key} is required")
            return errors

        # Skip validation if value is None and field is not required
        if value is None:
            return errors

        # Type validation
        expected_type = rules.get("type")
        if expected_type and not isinstance(value, expected_type):
            errors.append(f"{key} must be of type {expected_type.__name__}")
            return errors  # Skip further validation if type is wrong

        # Allowed values validation
        allowed_values = rules.get("allowed_values")
        if allowed_values and value not in allowed_values:
            errors.append(f"{key} must be one of: {', '.join(map(str, allowed_values))}")

        # Custom validator
        validator = rules.get("validator")
        if validator and callable(validator):
            try:
                validator(value)
            except ValidationError as e:
                errors.append(f"{key}: {e!s}")

        # Range validation for numeric types
        if isinstance(value, int | float):
            min_value = rules.get("min_value")
            max_value = rules.get("max_value")

            if min_value is not None and value < min_value:
                errors.append(f"{key} must be at least {min_value}")

            if max_value is not None and value > max_value:
                errors.append(f"{key} must be at most {max_value}")

        # String length validation
        if isinstance(value, str):
            min_length = rules.get("min_length")
            max_length = rules.get("max_length")

            if min_length is not None and len(value) < min_length:
                errors.append(f"{key} must be at least {min_length} characters long")

            if max_length is not None and len(value) > max_length:
                errors.append(f"{key} must be at most {max_length} characters long")

        return errors

    def _validate_audio_file_path(self, file_path: str,
    ) -> None:
        """Validate audio file path.
        
        Args:
            file_path: Path to audio file
            
        Raises:
            ValidationError: If file path is invalid
        """
        if not file_path:
            return  # Empty path is allowed

        path = Path(file_path)

        if not path.exists():
            msg = f"Audio file does not exist: {file_path}"
            raise ValidationError(msg)

        if not path.is_file():
            msg = f"Path is not a file: {file_path}"
            raise ValidationError(msg)

        # Check file extension
        allowed_extensions = {".mp3", ".wav", ".m4a", ".flac", ".ogg"}
        if path.suffix.lower() not in allowed_extensions:
            msg = f"Unsupported audio format: {path.suffix}"
            raise ValidationError(msg,
    )

    def _validate_hotkey(self, hotkey: str,
    ) -> None:
        """Validate hotkey string.
        
        Args:
            hotkey: Hotkey string
            
        Raises:
            ValidationError: If hotkey is invalid
        """
        if not hotkey:
            msg = "Hotkey cannot be empty"
            raise ValidationError(msg,
    )

        # Basic hotkey validation - check for common patterns
        valid_keys = {
            "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
            "ctrl", "alt", "shift", "space", "enter", "tab", "esc", "delete", "backspace",
            "home", "end", "pageup", "pagedown", "insert", "up", "down", "left", "right",
        }

        # Split by + for combination keys
        keys = [key.strip().lower() for key in hotkey.split("+")]

        for key in keys:
            # Check if it's a single character (a-z, 0-9)
            if len(key) == 1 and (key.isalnum() or key in "!@#$%^&*()_+-=[]{}|;:,.<>?"):
                continue

            # Check if it's a valid named key
            if key in valid_keys:
                continue

            msg = f"Invalid hotkey component: {key}"
            raise ValidationError(msg)

    def apply_defaults(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Apply default values to settings.
        
        Args:
            settings: Current settings dictionary
            
        Returns:
            Settings dictionary with defaults applied
        """
        result = settings.copy()

        for key, rules in self._validation_rules.items():
            if key not in result and "default" in rules:
                result[key] = rules["default"]

        if self.progress_callback:
            self.progress_callback(txt="Applied default values to settings")

        return result

    def sanitize_settings(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Sanitize settings by removing invalid entries and applying defaults.
        
        Args:
            settings: Settings dictionary to sanitize
            
        Returns:
            Sanitized settings dictionary
        """
        sanitized = {}

        for key, value in settings.items():
            if key in self._validation_rules:
                # Try to validate and fix the value
                try:
                    field_errors = self._validate_field(key, value, self._validation_rules[key])
                    if not field_errors:
                        sanitized[key] = value
                    elif "default" in self._validation_rules[key]:
                        sanitized[key] = self._validation_rules[key]["default"]
                except Exception:
                    # If validation fails, use default if available
                    if "default" in self._validation_rules[key]:
                        sanitized[key] = self._validation_rules[key]["default"]

        # Apply defaults for missing required fields
        sanitized = self.apply_defaults(sanitized)

        if self.progress_callback:
            self.progress_callback(txt="Settings sanitized successfully")

        return sanitized

    def add_validation_rule(self, key: str, rules: dict[str, Any]) -> None:
        """Add or update a validation rule.
        
        Args:
            key: Setting key
            rules: Validation rules dictionary
        """
        self._validation_rules[key] = rules

    def remove_validation_rule(self, key: str,
    ) -> None:
        """Remove a validation rule.
        
        Args:
            key: Setting key to remove
        """
        if key in self._validation_rules:
            del self._validation_rules[key]

    def get_validation_rules(self) -> dict[str, dict[str, Any]]:
        """Get current validation rules.
        
        Returns:
            Dictionary containing all validation rules
        """
        return self._validation_rules.copy()