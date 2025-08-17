"""VAD Smoothing Service.

This module implements the VADSmoothingService for smoothing VAD detections.
"""


from src.domain.audio.value_objects import VADConfiguration, VADDetection

from .vad_service import SmoothingServiceProtocol


class VADSmoothingService(SmoothingServiceProtocol):
    """Service for smoothing VAD detections."""

    def __init__(self):
        """Initialize the VAD smoothing service."""

    def apply_smoothing(self, detections: list[VADDetection], config: VADConfiguration,
    ) -> list[VADDetection]:
        """Apply smoothing to VAD detections."""
        try:
            if not detections:
                return []

            # Simple moving average smoothing
            window_size = 3  # Number of frames to average
            smoothed_detections = []

            for i in range(len(detections)):
                # Get window of detections around current frame
                start_idx = max(0, i - window_size // 2)
                end_idx = min(len(detections), i + window_size // 2 + 1)
                
                window = detections[start_idx:end_idx]
                
                # Calculate average confidence in window
                if window:
                    avg_confidence = sum(d.confidence for d in window) / len(window)
                    
                    # Create smoothed detection
                    smoothed_detection = VADDetection(
                        activity=detections[i].activity,
                        confidence=avg_confidence,
                        timestamp=detections[i].timestamp,
                        duration=detections[i].duration,
                        chunk_id=detections[i].chunk_id,
                        raw_score=avg_confidence,
                        smoothed_score=avg_confidence,
                    )
                    smoothed_detections.append(smoothed_detection)
                else:
                    smoothed_detections.append(detections[i])

            return smoothed_detections

        except Exception:
            # Return original detections if smoothing fails
            return detections

    def filter_short_segments(self, detections: list[VADDetection], min_duration: float,
    ) -> list[VADDetection]:
        """Filter out short speech segments."""
        try:
            if not detections:
                return []

            # Group consecutive speech segments
            filtered_detections = []
            current_segment = []
            
            for detection in detections:
                if detection.activity.value == "speech":
                    current_segment.append(detection)
                else:
                    # Check if current segment meets minimum duration
                    if current_segment:
                        segment_duration = len(current_segment) * 0.01  # Assuming 10ms frames
                        if segment_duration >= min_duration:
                            filtered_detections.extend(current_segment)
                        current_segment = []
                    filtered_detections.append(detection)

            # Handle final segment
            if current_segment:
                segment_duration = len(current_segment) * 0.01
                if segment_duration >= min_duration:
                    filtered_detections.extend(current_segment)

            return filtered_detections

        except Exception:
            # Return original detections if filtering fails
            return detections
