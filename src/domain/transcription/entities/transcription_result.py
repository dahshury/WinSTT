"""
Transcription Result Aggregate

Core aggregate for managing transcription results with business rules.
Extracted from utils/transcribe.py transcription processing logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING

from src.domain.audio.value_objects.audio_format import Duration
from src.domain.common.abstractions import AggregateRoot
from src.domain.common.domain_utils import DomainIdentityGenerator
from src.domain.common.events import DomainEvent
from src.domain.common.value_object import ProgressPercentage
from src.domain.transcription.value_objects.confidence_score import ConfidenceScore
from src.domain.transcription.value_objects.transcription_text import TranscriptionText

if TYPE_CHECKING:
    from src.domain.common.ports.serialization_port import SerializationPort
    from src.domain.transcription.value_objects.language import Language

    from .transcription_segment import TranscriptionSegment


class TranscriptionStatus(Enum):
    """Status of transcription processing."""
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class OutputFormat(Enum):
    """Supported output formats for transcription."""
    TXT = "txt"
    SRT = "srt"
    VTT = "vtt"
    JSON = "json"


@dataclass(frozen=True)
class TranscriptionStartedEvent(DomainEvent):
    """Domain event fired when transcription starts."""
    transcription_id: str
    audio_duration: Duration
    language: Language


@dataclass(frozen=True)
class TranscriptionCompletedEvent(DomainEvent):
    """Domain event fired when transcription completes."""
    transcription_id: str
    final_text: TranscriptionText
    segment_count: int
    processing_duration: Duration
    confidence: ConfidenceScore


@dataclass(frozen=True)
class TranscriptionFailedEvent(DomainEvent):
    """Domain event fired when transcription fails."""
    transcription_id: str
    error_message: str
    error_code: str


@dataclass(frozen=True)
class SegmentProcessedEvent(DomainEvent):
    """Domain event fired when a segment is processed."""
    transcription_id: str
    segment_id: str
    progress: ProgressPercentage


@dataclass
class TranscriptionResult(AggregateRoot):
    """
    Aggregate root for transcription results.
    
    Manages the complete transcription process including segments,
    confidence scores, and output generation.
    """
    transcription_id: str
    source_audio_id: str
    language: Language
    status: TranscriptionStatus = TranscriptionStatus.PENDING
    started_at: float | None = None
    completed_at: float | None = None
    segments: list[TranscriptionSegment] = field(default_factory=list)
    overall_confidence: ConfidenceScore = field(default_factory=lambda: ConfidenceScore(0.0))
    error_message: str | None = None
    model_version: str = ""
    processing_parameters: dict[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        super().__init__(self.transcription_id,
    )

    def start_transcription(self, audio_duration: Duration, model_version: str,
    ) -> None:
        """
        Start transcription process.
        Business rule: Can only start from PENDING status.
        """
        if self.status != TranscriptionStatus.PENDING:
            msg = f"Cannot start transcription from status: {self.status}"
            raise ValueError(msg)

        self.status = TranscriptionStatus.PROCESSING
        self.started_at = DomainIdentityGenerator.generate_timestamp()
        self.model_version = model_version
        self.segments.clear()
        self.overall_confidence = ConfidenceScore(0.0,
    )
        self.error_message = None

        # Raise domain event
        event = TranscriptionStartedEvent(
            event_id="",
            timestamp=0.0,
            source="TranscriptionResult",
            transcription_id=self.transcription_id,
            audio_duration=audio_duration,
            language=self.language,
        )
        self.add_domain_event(event)
        self.increment_version()

    def add_segment(self, segment: TranscriptionSegment,
    ) -> None:
        """
        Add a transcription segment.
        Business rule: Can only add segments while processing.
        """
        if self.status != TranscriptionStatus.PROCESSING:
            msg = f"Cannot add segment in status: {self.status}"
            raise ValueError(msg)

        # Business rule: Segments must not overlap significantly
        for existing_segment in self.segments:
            if segment.overlaps_with(existing_segment,
    ):
                overlap_duration = self._calculate_overlap(segment, existing_segment)
                if overlap_duration.seconds > 0.1:  # 100ms tolerance
                    msg = "Segment overlaps significantly with existing segment"
                    raise ValueError(msg)

        # Add segment in correct position (maintain chronological order)
        insert_position = 0
        for i, existing_segment in enumerate(self.segments):
            if segment.start_time.seconds > existing_segment.start_time.seconds:
                insert_position = i + 1
            else:
                break

        self.segments.insert(insert_position, segment)

        # Update overall confidence as running average
        self._update_overall_confidence()

        # Calculate progress
        if self.total_duration:
            covered_duration = sum(seg.duration.seconds for seg in self.segments)
            progress = ProgressPercentage.from_ratio(covered_duration / self.total_duration.seconds)
        else:
            # Rough estimate without magic: proportional to segment count capped by 100
            estimated = min(100.0, float(len(self.segments)) * 10.0)
            progress = ProgressPercentage(estimated)

        # Raise domain event
        event = SegmentProcessedEvent(
            event_id="",
            timestamp=0.0,
            source="TranscriptionResult",
            transcription_id=self.transcription_id,
            segment_id=segment.entity_id,
            progress=progress,
        )
        self.add_domain_event(event)
        self.increment_version()

    def complete_transcription(self) -> None:
        """
        Complete transcription process.
        Business rule: Can only complete from PROCESSING status.
        """
        if self.status != TranscriptionStatus.PROCESSING:
            msg = f"Cannot complete transcription from status: {self.status}"
            raise ValueError(msg)

        # Business rule: Must have at least one segment to be considered complete
        if not self.segments:
            msg = "Cannot complete transcription without segments"
            raise ValueError(msg)

        self.status = TranscriptionStatus.COMPLETED
        self.completed_at = DomainIdentityGenerator.generate_timestamp()

        # Final confidence calculation
        self._update_overall_confidence()

        # Generate final text
        final_text = self.get_full_text()

        # Raise domain event
        event = TranscriptionCompletedEvent(
            event_id="",
            timestamp=0.0,
            source="TranscriptionResult",
            transcription_id=self.transcription_id,
            final_text=final_text,
            segment_count=len(self.segments),
            processing_duration=self.processing_duration or Duration(seconds=0),
            confidence=self.overall_confidence,
        )
        self.add_domain_event(event)
        self.increment_version()

    def fail_transcription(
    self,
    error_message: str,
    error_code: str = "TRANSCRIPTION_ERROR") -> None:
        """Fail the transcription with an error."""
        self.status = TranscriptionStatus.FAILED
        self.error_message = error_message
        self.completed_at = DomainIdentityGenerator.generate_timestamp()

        # Raise domain event
        event = TranscriptionFailedEvent(
            event_id="",
            timestamp=0.0,
            source="TranscriptionResult",
            transcription_id=self.transcription_id,
            error_message=error_message,
            error_code=error_code,
        )
        self.add_domain_event(event)
        self.increment_version()

    def cancel_transcription(self, reason: str | None = None) -> None:
        """Cancel the transcription process."""
        if self.status in [TranscriptionStatus.COMPLETED, TranscriptionStatus.FAILED]:
            msg = f"Cannot cancel transcription in final status: {self.status}"
            raise ValueError(msg)

        self.status = TranscriptionStatus.CANCELLED
        if reason:
            self.error_message = reason
        self.completed_at = DomainIdentityGenerator.generate_timestamp()
        self.increment_version()

    def get_full_text(self) -> TranscriptionText:
        """Get complete transcription text from all segments."""
        if not self.segments:
            return TranscriptionText.empty()

        # Sort segments by start time
        sorted_segments = sorted(self.segments, key=lambda s: s.start_time.seconds)

        # Combine text from all segments
        full_text_parts = []
        for segment in sorted_segments:
            if not segment.text.is_empty:
                full_text_parts.append(segment.text.content)

        combined_text = " ".join(full_text_parts)
        return TranscriptionText.final(combined_text).apply_formatting_rules()

    def export_to_format(self, format_type: OutputFormat, serialization_port: SerializationPort | None = None) -> str:
        """
        Export transcription to specified format.
        Business rule: Can only export completed transcriptions.
        """
        if self.status != TranscriptionStatus.COMPLETED:
            msg = f"Cannot export transcription in status: {self.status}"
            raise ValueError(msg)

        if format_type == OutputFormat.TXT:
            return self.get_full_text().content

        if format_type == OutputFormat.SRT:
            return self._export_to_srt()

        if format_type == OutputFormat.VTT:
            return self._export_to_vtt()

        if format_type == OutputFormat.JSON:
            if serialization_port is None:
                msg = "SerializationPort is required for JSON export"
                raise ValueError(msg)
            return self._export_to_json(serialization_port)

        msg = f"Unsupported export format: {format_type}"
        raise ValueError(msg)

    def merge_adjacent_segments(self, max_gap_ms: float = 500) -> None:
        """
        Merge adjacent segments that are close together.
        Business rule: Can only merge during processing.
        """
        if self.status != TranscriptionStatus.PROCESSING:
            msg = f"Cannot merge segments in status: {self.status}"
            raise ValueError(msg)

        if len(self.segments,
    ) < 2:
            return

        # Sort segments by start time
        sorted_segments = sorted(self.segments, key=lambda s: s.start_time.seconds)
        merged_segments = []
        current_segment = sorted_segments[0]

        for next_segment in sorted_segments[1:]:
            if current_segment.is_adjacent_to(next_segment, max_gap_ms):
                # Merge segments
                current_segment = current_segment.merge_with(next_segment)
            else:
                # Keep current segment and move to next
                merged_segments.append(current_segment)
                current_segment = next_segment

        # Add the last segment
        merged_segments.append(current_segment)

        # Update segments list
        self.segments = merged_segments
        self._update_overall_confidence()
        self.increment_version()

    def _calculate_overlap(self, segment1: TranscriptionSegment, segment2: TranscriptionSegment,
    ) -> Duration:
        """Calculate overlap duration between two segments."""
        overlap_start = max(segment1.start_time.seconds, segment2.start_time.seconds)
        overlap_end = min(segment1.end_time.seconds, segment2.end_time.seconds)

        if overlap_start >= overlap_end:
            return Duration(0.0)

        return Duration(overlap_end - overlap_start)

    def _update_overall_confidence(self) -> None:
        """Update overall confidence based on segment confidences."""
        if not self.segments:
            self.overall_confidence = ConfidenceScore(0.0)
            return

        # Weighted average by segment duration
        total_weighted_confidence = 0.0
        total_duration = 0.0

        for segment in self.segments:
            weight = segment.duration.seconds
            total_weighted_confidence += segment.confidence.value * weight
            total_duration += weight

        if total_duration > 0:
            average_confidence = total_weighted_confidence / total_duration
            self.overall_confidence = ConfidenceScore(average_confidence)
        else:
            self.overall_confidence = ConfidenceScore(0.0)

    def _export_to_srt(self,
    ) -> str:
        """Export to SRT subtitle format."""
        srt_content = []
        sorted_segments = sorted(self.segments, key=lambda s: s.start_time.seconds)

        for i, segment in enumerate(sorted_segments, 1):
            srt_content.append(segment.to_srt_format(i))

        return "\n".join(srt_content)

    def _export_to_vtt(self) -> str:
        """Export to WebVTT format."""
        vtt_content = ["WEBVTT", ""]
        sorted_segments = sorted(self.segments, key=lambda s: s.start_time.seconds)

        for segment in sorted_segments:
            vtt_content.append(segment.to_vtt_format())

        return "\n".join(vtt_content)

    def _export_to_json(self, serialization_port: SerializationPort) -> str:
        """Export to JSON format using serialization port."""
        export_data = {
            "transcription_id": self.transcription_id,
            "language": self.language.code.value,
            "overall_confidence": self.overall_confidence.value,
            "full_text": self.get_full_text().content,
            "segments": [
                {
                    "start": segment.start_time.seconds,
                    "end": segment.end_time.seconds,
                    "text": segment.text.content,
                    "confidence": segment.confidence.value,
                }
                for segment in sorted(self.segments, key=lambda s: s.start_time.seconds)
            ],
            "metadata": {
                "model_version": self.model_version,
                "processed_at": self.completed_at if self.completed_at else None,
                "processing_duration_seconds": self.processing_duration.seconds if self.processing_duration else None,
            },
        }

        # Serialize using port
        serialize_result = serialization_port.serialize_to_json(export_data)
        if not serialize_result.is_success:
            return "{}"  # Return empty JSON on error
        
        # Pretty print for better readability
        if serialize_result.value is not None:
            pretty_result = serialization_port.pretty_print_json(serialize_result.value, indent=2)
            return pretty_result.value if pretty_result.is_success and pretty_result.value else serialize_result.value
        return ""

    @property
    def total_duration(self) -> Duration | None:
        """Get total duration covered by all segments."""
        if not self.segments:
            return None

        sorted_segments = sorted(self.segments, key=lambda s: s.start_time.seconds)
        start_time = sorted_segments[0].start_time.seconds
        end_time = sorted_segments[-1].end_time.seconds

        return Duration(end_time - start_time)

    @property
    def processing_duration(self) -> Duration | None:
        """Get processing duration."""
        if not self.started_at or not self.completed_at:
            return None

        duration_seconds = float(self.completed_at - self.started_at)
        return Duration(duration_seconds)

    @property
    def is_active(self) -> bool:
        """Check if transcription is actively processing."""
        return self.status == TranscriptionStatus.PROCESSING

    @property
    def is_finished(self) -> bool:
        """Check if transcription is in a final state."""
        return self.status in [
            TranscriptionStatus.COMPLETED,
            TranscriptionStatus.FAILED,
            TranscriptionStatus.CANCELLED,
        ]

    @property
    def segment_count(self) -> int:
        """Get number of segments."""
        return len(self.segments)

    @property
    def average_confidence(self) -> ConfidenceScore:
        """Get average confidence score."""
        return self.overall_confidence

    def validate_transcription_quality(self) -> bool:
        """
        Validate transcription meets quality requirements.
        
        Business rules:
        - Must have reasonable confidence score
        - Must have non-empty text
        - Segments should be reasonable duration
        """
        if self.status != TranscriptionStatus.COMPLETED:
            return False

        # Check overall confidence
        if not self.overall_confidence.is_reliable:
            return False

        # Check for meaningful content
        full_text = self.get_full_text()
        if full_text.is_empty or full_text.word_count < 1:
            return False

        # Check segment quality
        if not self.segments:
            return False

        # Check for reasonable segment durations
        for segment in self.segments:
            if segment.duration.seconds > 30:  # Very long segments might indicate issues
                return False
            if (segment.duration.seconds < 0.1 and not segment.text.is_empty):  # Very short segments with content
                return False

        return True