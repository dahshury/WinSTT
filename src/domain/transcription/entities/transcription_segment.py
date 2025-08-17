"""
Transcription Segment Entity

Represents a segment of transcribed audio with timing information.
Extracted from segment processing logic in utils/transcribe.py.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from src.domain.audio.value_objects.audio_format import Duration
from src.domain.common.abstractions import Entity
from src.domain.transcription.value_objects.confidence_score import ConfidenceScore
from src.domain.transcription.value_objects.transcription_text import TranscriptionText


@dataclass
class TranscriptionSegment(Entity):
    """
    Entity representing a timed segment of transcribed audio.
    
    Contains the transcribed text along with timing information,
    confidence scores, and segment metadata.
    """
    start_time: Duration = field(default_factory=lambda: Duration(0.0))
    end_time: Duration = field(default_factory=lambda: Duration(0.0))
    text: TranscriptionText = field(default_factory=lambda: TranscriptionText(""))
    confidence: ConfidenceScore = field(default_factory=lambda: ConfidenceScore(1.0))
    speaker_id: str | None = None
    language_detected: str | None = None
    sequence_number: int = 0

    def __post_init__(self) -> None:
        super().__post_init__()

        # Business rule: Start time must be before end time
        if self.start_time.seconds >= self.end_time.seconds:
            msg = (
                f"Start time ({self.start_time.seconds}s) must be before end time ({self.end_time.seconds}s)")
            raise ValueError(msg)

        # Business rule: Segments should not be too short (unless it's the only segment)
        if self.duration.seconds < 0.1 and not self.text.is_empty:
            msg = f"Segment too short: {self.duration.seconds}s"
            raise ValueError(msg)

    @property
    def duration(self) -> Duration:
        """Calculate segment duration."""
        return Duration(self.end_time.seconds - self.start_time.seconds)

    @property
    def start_time_ms(self) -> float:
        """Get start time in milliseconds."""
        return self.start_time.milliseconds

    @property
    def end_time_ms(self) -> float:
        """Get end time in milliseconds."""
        return self.end_time.milliseconds

    @property
    def duration_ms(self) -> float:
        """Get duration in milliseconds."""
        return self.duration.milliseconds

    @property
    def is_empty(self) -> bool:
        """Check if segment has no meaningful content."""
        return self.text.is_empty

    @property
    def is_reliable(self) -> bool:
        """Check if segment has reliable transcription."""
        return self.confidence.is_reliable and not self.text.is_empty

    @property
    def speaking_rate_wpm(self,
    ) -> float:
        """Calculate speaking rate in words per minute."""
        if self.duration.seconds <= 0:
            return 0.0

        words_per_second = self.text.word_count / self.duration.seconds
        return words_per_second * 60.0

    def overlaps_with(self, other: TranscriptionSegment,
    ) -> bool:
        """Check if this segment overlaps with another segment."""
        return not (
            self.end_time.seconds <= other.start_time.seconds or
            other.end_time.seconds <= self.start_time.seconds
        )

    def is_adjacent_to(self, other: TranscriptionSegment, tolerance_ms: float = 100) -> bool:
        """Check if this segment is adjacent to another (within tolerance)."""
        tolerance_seconds = tolerance_ms / 1000.0

        # Check if this segment ends near where the other starts
        end_to_start_gap = abs(other.start_time.seconds - self.end_time.seconds)
        # Check if the other segment ends near where this starts
        start_to_end_gap = abs(self.start_time.seconds - other.end_time.seconds)

        return min(end_to_start_gap, start_to_end_gap) <= tolerance_seconds

    def merge_with(self, other: TranscriptionSegment,
    ) -> TranscriptionSegment:
        """
        Merge this segment with another adjacent segment.
        Business rule: Only merge adjacent or overlapping segments.
        """
        if not (self.overlaps_with(other) or self.is_adjacent_to(other)):
            msg = "Can only merge overlapping or adjacent segments"
            raise ValueError(msg)

        # Determine merged timing
        merged_start = Duration(min(self.start_time.seconds, other.start_time.seconds))
        merged_end = Duration(max(self.end_time.seconds, other.end_time.seconds))

        # Merge text content
        if self.sequence_number <= other.sequence_number:
            merged_text_content = f"{self.text.content} {other.text.content}".strip()
        else:
            merged_text_content = f"{other.text.content} {self.text.content}".strip()

        merged_text = TranscriptionText(content=merged_text_content, is_final=True)

        # Average confidence scores
        merged_confidence = self.confidence.combine_with(other.confidence)

        # Create merged segment
        return TranscriptionSegment(
            entity_id=f"{self.entity_id}_{other.entity_id}",
            start_time=merged_start,
            end_time=merged_end,
            text=merged_text,
            confidence=merged_confidence,
            speaker_id=self.speaker_id,  # Keep first segment's speaker
            language_detected=self.language_detected,
            sequence_number=min(self.sequence_number, other.sequence_number),
        )

    def split_at(self, split_time: Duration,
    ) -> tuple[TranscriptionSegment, TranscriptionSegment]:
        """
        Split segment at specified time.
        Business rule: Split time must be within segment boundaries.
        """
        if not (self.start_time.seconds < split_time.seconds < self.end_time.seconds):
            msg = (
                f"Split time {split_time.seconds}s must be within segment bounds "
                f"({self.start_time.seconds}s - {self.end_time.seconds}s)")
            raise ValueError(msg)

        # Calculate approximate split point in text
        split_ratio = (split_time.seconds - self.start_time.seconds) / self.duration.seconds
        text_split_point = int(len(self.text.content) * split_ratio)

        # Try to split at word boundary
        first_part = self.text.content[:text_split_point]
        second_part = self.text.content[text_split_point:]

        # Adjust split point to nearest word boundary
        if " " in first_part:
            last_space = first_part.rfind(" ")
            if last_space > len(first_part) * 0.7:  # Only adjust if reasonably close
                first_part = first_part[:last_space]
                second_part = self.text.content[last_space:].lstrip()

        # Create first segment
        first_segment = TranscriptionSegment(
            entity_id=f"{self.entity_id}_1",
            start_time=self.start_time,
            end_time=split_time,
            text=TranscriptionText(content=first_part, is_final=True),
            confidence=self.confidence,
            speaker_id=self.speaker_id,
            language_detected=self.language_detected,
            sequence_number=self.sequence_number,
        )

        # Create second segment
        second_segment = TranscriptionSegment(
            entity_id=f"{self.entity_id}_2",
            start_time=split_time,
            end_time=self.end_time,
            text=TranscriptionText(content=second_part, is_final=True),
            confidence=self.confidence,
            speaker_id=self.speaker_id,
            language_detected=self.language_detected,
            sequence_number=self.sequence_number + 1,
        )

        return first_segment, second_segment

    def to_srt_format(self, segment_index: int,
    ) -> str:
        """
        Convert segment to SRT subtitle format.
        
        Format:
        1
        00:00:00,000 --> 00:00:02,500
        This is the transcribed text.
        """
        def format_timestamp(duration: Duration,
    ) -> str:
            """Format duration as SRT timestamp (HH:MM:SS,mmm)."""
            total_ms = int(duration.milliseconds)
            hours = total_ms // 3600000
            minutes = (total_ms % 3600000) // 60000
            seconds = (total_ms % 60000) // 1000
            milliseconds = total_ms % 1000
            return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"

        start_timestamp = format_timestamp(self.start_time)
        end_timestamp = format_timestamp(self.end_time)

        return f"{segment_index}\n{start_timestamp} --> {end_timestamp}\n{self.text.content}\n"

    def to_vtt_format(self) -> str:
        """Convert segment to WebVTT format."""
        def format_timestamp(duration: Duration,
    ) -> str:
            """Format duration as VTT timestamp (HH:MM:SS.mmm)."""
            total_ms = int(duration.milliseconds)
            hours = total_ms // 3600000
            minutes = (total_ms % 3600000) // 60000
            seconds = (total_ms % 60000) // 1000
            milliseconds = total_ms % 1000
            return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{milliseconds:03d}"

        start_timestamp = format_timestamp(self.start_time)
        end_timestamp = format_timestamp(self.end_time)

        return f"{start_timestamp} --> {end_timestamp}\n{self.text.content}\n"

    @classmethod
    def create_simple_segment(
        cls,
        start_seconds: float,
        end_seconds: float,
        text_content: str,
        sequence_num: int = 0,
    ) -> TranscriptionSegment:
        """Create a simple segment with basic parameters."""
        return cls(
            entity_id=f"segment_{sequence_num}",
            start_time=Duration(start_seconds),
            end_time=Duration(end_seconds),
            text=TranscriptionText.final(text_content),
            sequence_number=sequence_num,
        )