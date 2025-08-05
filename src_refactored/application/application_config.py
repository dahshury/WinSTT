"""Application Configuration for WinSTT

This module provides application-level configuration management,
including environment setup, logging configuration, and warning suppression.
"""

import logging
import os
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class LoggingConfiguration:
    """Configuration for application logging."""
    
    transformers_level: int = logging.ERROR
    qt_logging_rules: str = "qt.gui.imageio=false;*.debug=false;qt.qpa.*=false"
    
    def apply(self) -> None:
        """Apply logging configuration."""
        logging.getLogger("transformers").setLevel(self.transformers_level)
        os.environ["QT_LOGGING_RULES"] = self.qt_logging_rules


@dataclass(frozen=True)
class EnvironmentConfiguration:
    """Configuration for environment variables."""
    
    pygame_hide_support_prompt: str = "hide"
    python_warnings: str = "ignore::DeprecationWarning,ignore::SyntaxWarning,ignore::UserWarning"
    
    def apply(self) -> None:
        """Apply environment configuration."""
        os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = self.pygame_hide_support_prompt
        os.environ["PYTHONWARNINGS"] = self.python_warnings


@dataclass(frozen=True)
class WarningConfiguration:
    """Configuration for warning suppression."""
    
    syntax_warnings: bool = True
    pygame_warnings: bool = True
    pydub_warnings: bool = True
    pkg_resources_warnings: bool = True
    
    def apply(self) -> None:
        """Apply warning suppression configuration."""
        if self.syntax_warnings:
            warnings.filterwarnings("ignore", category=SyntaxWarning)
        
        if self.pygame_warnings:
            warnings.filterwarnings("ignore", category=UserWarning, module="pygame")
        
        if self.pydub_warnings:
            warnings.filterwarnings("ignore", category=UserWarning, module="pydub")
        
        if self.pkg_resources_warnings:
            warnings.filterwarnings("ignore", message="pkg_resources is deprecated")


@dataclass(frozen=True)
class PlatformConfiguration:
    """Configuration for platform-specific features."""
    
    has_win32gui: bool = False
    
    @classmethod
    def detect(cls) -> "PlatformConfiguration":
        """Detect platform-specific capabilities."""
        has_win32gui = False
        
        if os.name in ("nt", "win32"):
            try:
                import win32gui
                has_win32gui = True
            except ImportError:
                has_win32gui = False
        
        return cls(has_win32gui=has_win32gui)


@dataclass(frozen=True)
class PathConfiguration:
    """Configuration for application paths."""
    
    root_path: Path
    src_path: Path
    resources_path: Path
    
    @classmethod
    def create_default(cls) -> "PathConfiguration":
        """Create default path configuration."""
        root_path = Path(__file__).parent.parent.parent.parent
        src_path = root_path / "src"
        resources_path = root_path / "resources"
        
        return cls(
            root_path=root_path,
            src_path=src_path,
            resources_path=resources_path,
        )
    
    def setup_python_path(self) -> None:
        """Setup Python path for imports."""
        root_str = str(self.root_path)
        if root_str not in sys.path:
            sys.path.insert(0, root_str)


class ApplicationConfiguration:
    """Main application configuration manager."""
    
    def __init__(
        self,
        logging_config: LoggingConfiguration | None = None,
        environment_config: EnvironmentConfiguration | None = None,
        warning_config: WarningConfiguration | None = None,
        platform_config: PlatformConfiguration | None = None,
        path_config: PathConfiguration | None = None,
    ):
        self.logging_config = logging_config or LoggingConfiguration()
        self.environment_config = environment_config or EnvironmentConfiguration()
        self.warning_config = warning_config or WarningConfiguration()
        self.platform_config = platform_config or PlatformConfiguration.detect()
        self.path_config = path_config or PathConfiguration.create_default()
    
    def initialize(self) -> None:
        """Initialize all application configuration."""
        # Setup paths first
        self.path_config.setup_python_path()
        
        # Apply environment configuration
        self.environment_config.apply()
        
        # Apply logging configuration
        self.logging_config.apply()
        
        # Apply warning suppression
        self.warning_config.apply()
    
    @property
    def has_win32gui(self) -> bool:
        """Check if win32gui is available."""
        return self.platform_config.has_win32gui
    
    @property
    def root_path(self) -> Path:
        """Get the application root path."""
        return self.path_config.root_path
    
    @property
    def resources_path(self) -> Path:
        """Get the resources path."""
        return self.path_config.resources_path


def create_default_configuration() -> ApplicationConfiguration:
    """Create default application configuration."""
    return ApplicationConfiguration()


def create_configuration(
    logging_level: int = logging.ERROR,
    suppress_warnings: bool = True,
    custom_paths: dict[str, str] | None = None,
) -> ApplicationConfiguration:
    """Create customized application configuration.
    
    Args:
        logging_level: Logging level for transformers
        suppress_warnings: Whether to suppress warnings
        custom_paths: Custom path overrides
    
    Returns:
        Configured ApplicationConfiguration instance
    """
    logging_config = LoggingConfiguration(transformers_level=logging_level)
    
    warning_config = WarningConfiguration(
        syntax_warnings=suppress_warnings,
        pygame_warnings=suppress_warnings,
        pydub_warnings=suppress_warnings,
        pkg_resources_warnings=suppress_warnings,
    )
    
    path_config = PathConfiguration.create_default()
    if custom_paths:
        # Override paths if provided
        root_path = Path(custom_paths.get("root", path_config.root_path))
        src_path = Path(custom_paths.get("src", path_config.src_path))
        resources_path = Path(custom_paths.get("resources", path_config.resources_path))
        
        path_config = PathConfiguration(
            root_path=root_path,
            src_path=src_path,
            resources_path=resources_path,
        )
    
    return ApplicationConfiguration(
        logging_config=logging_config,
        warning_config=warning_config,
        path_config=path_config,
    )