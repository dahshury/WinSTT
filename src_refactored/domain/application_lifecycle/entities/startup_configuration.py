"""Startup Configuration Entity.

This module contains the StartupConfiguration entity for application startup settings.
"""

from dataclasses import dataclass, field

from src_refactored.domain.common.entity import Entity
from src_refactored.domain.common.ports.logging_port import LogLevel


@dataclass
class StartupConfiguration(Entity[str]):
    """Configuration for application startup.
    
    This entity encapsulates all the settings and preferences for how
    the application should start up, including environment, logging, and UI settings.
    """

    app_name: str = "WinSTT"
    app_icon_path: str | None = None
    single_instance_port: int = 47123
    quit_on_last_window_closed: bool = False
    enable_logging: bool = True
    log_level: LogLevel = LogLevel.INFO
    suppress_warnings: bool = True
    environment_variables: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        # Generate ID based on app name and key settings
        config_id = f"{self.app_name}_{self.single_instance_port}_{self.log_level}"
        super().__init__(config_id)

        if not self.environment_variables:
            self.environment_variables = {
                "PYGAME_HIDE_SUPPORT_PROMPT": "hide",
                "PYTHONWARNINGS": "ignore::DeprecationWarning,ignore::SyntaxWarning,ignore::UserWarning",
                "QT_LOGGING_RULES": "qt.gui.imageio=false;*.debug=false;qt.qpa.*=false",
            }

    def is_logging_enabled(self) -> bool:
        """Check if logging is enabled."""
        return self.enable_logging

    def is_debug_mode(self) -> bool:
        """Check if debug logging is enabled."""
        return self.log_level.value <= LogLevel.DEBUG.value

    def has_custom_icon(self) -> bool:
        """Check if custom icon path is configured."""
        return self.app_icon_path is not None and self.app_icon_path.strip() != ""

    def get_environment_variable(self, key: str, default: str | None = None) -> str | None:
        """Get environment variable value."""
        return self.environment_variables.get(key, default)

    def add_environment_variable(self, key: str, value: str,
    ) -> None:
        """Add or update environment variable."""
        self.environment_variables[key] = value
        self.mark_as_updated()

    def remove_environment_variable(self, key: str,
    ) -> bool:
        """Remove environment variable."""
        if key in self.environment_variables:
            del self.environment_variables[key]
            self.mark_as_updated()
            return True
        return False

    def __invariants__(self) -> None:
        """Validate entity invariants."""
        if not self.app_name or not self.app_name.strip():
            msg = "App name cannot be empty"
            raise ValueError(msg)
        if self.single_instance_port <= 0 or self.single_instance_port > 65535:
            msg = "Single instance port must be between 1 and 65535"
            raise ValueError(msg)
        if not isinstance(self.log_level, LogLevel):
            msg = "Log level must be a valid LogLevel enum value"
            raise ValueError(msg)
        if self.app_icon_path is not None and self.app_icon_path.strip() == "":
            msg = "App icon path cannot be empty string"
            raise ValueError(msg,
    )