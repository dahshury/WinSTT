"""Message display value object for UI coordination."""

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class MessageType(Enum):
    """Types of messages that can be displayed."""
    INFO = "info"
    SUCCESS = "success"
    WARNING = "warning"
    ERROR = "error"
    PROGRESS = "progress"
    DOWNLOAD = "download"
    TRANSCRIPTION = "transcription"
    INSTRUCTION = "instruction"


class MessagePriority(Enum):
    """Priority levels for messages."""
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


class DisplayBehavior(Enum):
    """How the message should be displayed."""
    TEMPORARY = "temporary"  # Auto-fade after timeout
    PERSISTENT = "persistent"  # Stay until explicitly cleared
    HOLD = "hold"  # Stay until user action or process completion
    REPLACE = "replace"  # Replace current message immediately


@dataclass(frozen=True)
class MessageDisplay(ValueObject):
    """Represents a message to be displayed in the UI."""

    text: str
    message_type: MessageType
    priority: MessagePriority = MessagePriority.NORMAL
    behavior: DisplayBehavior = DisplayBehavior.TEMPORARY
    timeout_ms: int = 5000
    fade_duration_ms: int = 3000
    filename: str | None = None
    progress_percentage: int | None = None

    def __post_init__(self):
        """Validate message display parameters."""
        if not self.text.strip():
            msg = "Message text cannot be empty"
            raise ValueError(msg)

        if self.timeout_ms <= 0:
            msg = "Timeout must be positive"
            raise ValueError(msg)

        if self.fade_duration_ms <= 0:
            msg = "Fade duration must be positive"
            raise ValueError(msg)

        if self.progress_percentage is not None:
            if not (0 <= self.progress_percentage <= 100):
                msg = "Progress percentage must be between 0 and 100"
                raise ValueError(msg)
            if self.message_type != MessageType.PROGRESS:
                msg = "Progress percentage only valid for progress messages"
                raise ValueError(msg)

    @classmethod
    def info(cls, text: str, timeout_ms: int = 5000,
    ) -> "MessageDisplay":
        """Create an info message."""
        return cls(
            text=text,
            message_type=MessageType.INFO,
            timeout_ms=timeout_ms,
        )

    @classmethod
    def success(cls, text: str, timeout_ms: int = 3000,
    ) -> "MessageDisplay":
        """Create a success message."""
        return cls(
            text=text,
            message_type=MessageType.SUCCESS,
            priority=MessagePriority.HIGH,
            timeout_ms=timeout_ms,
        )

    @classmethod
    def error(cls, text: str, persistent: bool = True,
    ) -> "MessageDisplay":
        """Create an error message."""
        return cls(
            text=text,
            message_type=MessageType.ERROR,
            priority=MessagePriority.CRITICAL,
            behavior=DisplayBehavior.PERSISTENT if persistent else DisplayBehavior.TEMPORARY,
            timeout_ms=10000,
        )

    @classmethod
    def download_progress(cls, filename: str, percentage: int,
    ) -> "MessageDisplay":
        """Create a download progress message."""
        return cls(
            text=f"Downloading {filename}...",
            message_type=MessageType.DOWNLOAD,
            behavior=DisplayBehavior.HOLD,
            filename=filename,
            progress_percentage=percentage,
        )

    @classmethod
    def transcription_progress(cls, percentage: int, hold: bool = True,
    ) -> "MessageDisplay":
        """Create a transcription progress message."""
        return cls(
            text="Transcribing...",
            message_type=MessageType.TRANSCRIPTION,
            behavior=DisplayBehavior.HOLD if hold else DisplayBehavior.TEMPORARY,
            progress_percentage=percentage,
        )

    @classmethod
    def instruction(cls, text: str, key_combination: str,
    ) -> "MessageDisplay":
        """Create an instruction message."""
        formatted_text = f"Hold {key_combination} to record or drag & drop to transcribe"
        return cls(
            text=formatted_text,
            message_type=MessageType.INSTRUCTION,
            behavior=DisplayBehavior.PERSISTENT,
        )

    def with_progress(self, percentage: int,
    ) -> "MessageDisplay":
        """Create a new message with updated progress."""
        if self.message_type not in [MessageType.PROGRESS, MessageType.DOWNLOAD, MessageType.TRANSCRIPTION]:
            msg = "Progress updates only valid for progress-type messages"
            raise ValueError(msg)

        return MessageDisplay(
            text=self.text,
            message_type=self.message_type,
            priority=self.priority,
            behavior=self.behavior,
            timeout_ms=self.timeout_ms,
            fade_duration_ms=self.fade_duration_ms,
            filename=self.filename,
            progress_percentage=percentage,
        )

    def should_auto_fade(self) -> bool:
        """Check if message should automatically fade out."""
        return self.behavior == DisplayBehavior.TEMPORARY

    def should_hold(self) -> bool:
        """Check if message should be held until explicitly cleared."""
        return self.behavior in [DisplayBehavior.HOLD, DisplayBehavior.PERSISTENT]

    def is_progress_message(self) -> bool:
        """Check if this is a progress-related message."""
        return self.message_type in [MessageType.PROGRESS, MessageType.DOWNLOAD, MessageType.TRANSCRIPTION]

    def get_display_text(self) -> str:
        """Get the formatted text for display."""
        if self.filename and self.message_type == MessageType.DOWNLOAD:
            return f"Downloading {self.filename}..."
        return self.text