"""Single Instance Configuration Entity.

This module contains the SingleInstanceConfiguration entity for single instance checking settings.
"""

from dataclasses import dataclass

from src_refactored.domain.application_lifecycle.value_objects import InstanceCheckMethod
from src_refactored.domain.common.entity import Entity
from src_refactored.domain.window_management.value_objects import ActivationMethod


@dataclass
class SingleInstanceConfiguration(Entity[str]):
    """Configuration for single instance checking.
    
    This entity encapsulates all the settings for checking and enforcing
    single instance behavior of the application.
    """

    check_method: InstanceCheckMethod = InstanceCheckMethod.SOCKET_BINDING
    activation_method: ActivationMethod = ActivationMethod.WIN32_API
    socket_port: int = 65432
    socket_host: str = "127.0.0.1"
    lock_file_path: str | None = None
    mutex_name: str | None = None
    activation_timeout_seconds: int = 5
    retry_attempts: int = 3
    retry_delay_seconds: float = 0.5
    cleanup_on_exit: bool = True

    def __post_init__(self):
        # Generate ID based on configuration
config_id = (
    f"{self.check_method.value}_{self.socket_port}_{self.activation_timeout_seconds}")
        super().__init__(config_id)

    def is_socket_based(self) -> bool:
        """Check if configuration uses socket-based checking."""
        return self.check_method == InstanceCheckMethod.SOCKET_BINDING

    def is_file_lock_based(self) -> bool:
        """Check if configuration uses file lock-based checking."""
        return self.check_method == InstanceCheckMethod.FILE_LOCK

    def is_mutex_based(self) -> bool:
        """Check if configuration uses mutex-based checking."""
        return self.check_method == InstanceCheckMethod.NAMED_MUTEX

    def is_process_based(self) -> bool:
        """Check if configuration uses process-based checking."""
        return self.check_method == InstanceCheckMethod.PROCESS_CHECK

    def get_socket_address(self,
    ) -> tuple[str, int]:
        """Get socket address tuple."""
        return (self.socket_host, self.socket_port)

    def get_total_timeout(self) -> float:
        """Calculate total timeout including retries."""
        return self.activation_timeout_seconds + (self.retry_attempts * self.retry_delay_seconds)

    def __invariants__(self) -> None:
        """Validate entity invariants."""
        if self.socket_port <= 0 or self.socket_port > 65535:
            msg = "Socket port must be between 1 and 65535"
            raise ValueError(msg)
        if not self.socket_host:
            msg = "Socket host cannot be empty"
            raise ValueError(msg)
        if self.activation_timeout_seconds <= 0:
            msg = "Activation timeout must be positive"
            raise ValueError(msg)
        if self.retry_attempts < 0:
            msg = "Retry attempts cannot be negative"
            raise ValueError(msg)
        if self.retry_delay_seconds < 0:
            msg = "Retry delay cannot be negative"
            raise ValueError(msg)
        if self.check_method == InstanceCheckMethod.FILE_LOCK and not self.lock_file_path:
            msg = "Lock file path required for file lock method"
            raise ValueError(msg)
        if self.check_method == InstanceCheckMethod.NAMED_MUTEX and not self.mutex_name:
            msg = "Mutex name required for named mutex method"
            raise ValueError(msg,
    )