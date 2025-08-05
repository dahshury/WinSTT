"""Transcription file repository for managing transcription persistence."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from src_refactored.domain.transcription.value_objects import ProgressCallback


class TranscriptionFileRepository:
    """Infrastructure service for managing transcription file operations."""

    def __init__(
    self,
    base_path: str | None = None,
    progress_callback: ProgressCallback | None = None):
        """Initialize the transcription file repository.
        
        Args:
            base_path: Base path for transcription storage
            progress_callback: Optional callback for progress updates
        """
        self.base_path = Path(base_path) if base_path else Path.cwd() / "transcriptions"
        self.progress_callback = progress_callback
        self._ensure_base_directory()

    def _ensure_base_directory(self) -> None:
        """Ensure base directory exists."""
        self.base_path.mkdir(parents=True, exist_ok=True)

    def save_transcription_text(self, audio_file_path: str, transcription: str,
                               output_format: str = "txt",
    ) -> str:
        """Save transcription as text file.
        
        Args:
            audio_file_path: Path to the original audio file
            transcription: Transcription text
            output_format: Output format ('txt', 'srt', 'json')
            
        Returns:
            Path to the saved transcription file
        """
        audio_path = Path(audio_file_path)
        base_name = audio_path.stem

        if output_format.lower() == "srt":
            output_path = self.base_path / f"{base_name}.srt"
            content = self._format_as_srt(transcription)
        elif output_format.lower() == "json":
            output_path = self.base_path / f"{base_name}.json"
            content = self._format_as_json(transcription, audio_file_path)
        else:
            output_path = self.base_path / f"{base_name}.txt"
            content = transcription

        with open(output_path, "w", encoding="utf-8") as f:
            if output_format.lower() == "json":
                json.dump(content, f, indent=2, ensure_ascii=False)
            else:
                f.write(content)

        if self.progress_callback:
            self.progress_callback(txt=f"Saved transcription to {output_path.name}")

        return str(output_path)

    def save_transcription_segments(self, audio_file_path: str, segments: list[dict[str, Any]],
                                   output_format: str = "srt",
    ) -> str:
        """Save transcription segments with timestamps.
        
        Args:
            audio_file_path: Path to the original audio file
            segments: List of transcription segments with timestamps
            output_format: Output format ('srt', 'json', 'vtt')
            
        Returns:
            Path to the saved transcription file
        """
        audio_path = Path(audio_file_path)
        base_name = audio_path.stem

        if output_format.lower() == "srt":
            output_path = self.base_path / f"{base_name}.srt"
            content = self._segments_to_srt(segments)
        elif output_format.lower() == "vtt":
            output_path = self.base_path / f"{base_name}.vtt"
            content = self._segments_to_vtt(segments)
        else:
            output_path = self.base_path / f"{base_name}.json"
            content = {
                "audio_file": audio_file_path,
                "timestamp": datetime.now().isoformat(),
                "segments": segments,
            }

        with open(output_path, "w", encoding="utf-8") as f:
            if output_format.lower() == "json":
                json.dump(content, f, indent=2, ensure_ascii=False)
            else:
                f.write(content)

        if self.progress_callback:
            self.progress_callback(txt=f"Saved segmented transcription to {output_path.name}")

        return str(output_path)

    def load_transcription(self, transcription_file_path: str,
    ) -> dict[str, Any]:
        """Load transcription from file.
        
        Args:
            transcription_file_path: Path to the transcription file
            
        Returns:
            Dictionary containing transcription data
            
        Raises:
            FileNotFoundError: If transcription file doesn't exist
        """
        file_path = Path(transcription_file_path)
        if not file_path.exists():
            msg = f"Transcription file not found: {file_path}"
            raise FileNotFoundError(msg)

        if file_path.suffix.lower() == ".json":
            with open(file_path, encoding="utf-8") as f:
                return json.load(f)
        else:
            with open(file_path, encoding="utf-8") as f:
                content = f.read()
            return {
                "text": content,
                "format": file_path.suffix[1:],
                "file_path": str(file_path),
            }

    def list_transcriptions(self, audio_file_path: str | None = None) -> list[str]:
        """List available transcription files.
        
        Args:
            audio_file_path: Optional audio file path to filter transcriptions
            
        Returns:
            List of transcription file paths
        """
        if audio_file_path:
            audio_path = Path(audio_file_path)
            base_name = audio_path.stem
            pattern = f"{base_name}.*"
        else:
            pattern = "*"

        transcription_files = []
        for file_path in self.base_path.glob(pattern):
            if file_path.is_file() and file_path.suffix.lower() in [".txt", ".srt", ".json", ".vtt"]:
                transcription_files.append(str(file_path))

        return sorted(transcription_files)

    def delete_transcription(self, transcription_file_path: str,
    ) -> bool:
        """Delete a transcription file.
        
        Args:
            transcription_file_path: Path to the transcription file
            
        Returns:
            True if file was deleted, False otherwise
        """
        file_path = Path(transcription_file_path)
        if file_path.exists():
            file_path.unlink()
            if self.progress_callback:
                self.progress_callback(txt=f"Deleted transcription {file_path.name}")
            return True
        return False

    def _format_as_srt(self, transcription: str,
    ) -> str:
        """Format transcription as SRT subtitle format."""
        # Simple SRT format for single transcription
        return f"1\n00:00:00,000 --> 00:00:10,000\n{transcription}\n"

    def _format_as_json(self, transcription: str, audio_file_path: str,
    ) -> dict[str, Any]:
        """Format transcription as JSON."""
        return {
            "audio_file": audio_file_path,
            "timestamp": datetime.now().isoformat(),
            "transcription": transcription,
        }

    def _segments_to_srt(self, segments: list[dict[str, Any]]) -> str:
        """Convert segments to SRT format."""
        srt_content = []
        for i, segment in enumerate(segments, 1):
            start_time = self._seconds_to_srt_time(segment.get("start", 0))
            end_time = self._seconds_to_srt_time(segment.get("end", 0))
            text = segment.get("text", "").strip()

            srt_content.append(f"{i}")
            srt_content.append(f"{start_time} --> {end_time}")
            srt_content.append(text)
            srt_content.append("")  # Empty line between segments

        return "\n".join(srt_content)

    def _segments_to_vtt(self, segments: list[dict[str, Any]]) -> str:
        """Convert segments to WebVTT format."""
        vtt_content = ["WEBVTT", ""]

        for segment in segments:
            start_time = self._seconds_to_vtt_time(segment.get("start", 0))
            end_time = self._seconds_to_vtt_time(segment.get("end", 0))
            text = segment.get("text", "").strip()

            vtt_content.append(f"{start_time} --> {end_time}")
            vtt_content.append(text)
            vtt_content.append("")  # Empty line between segments

        return "\n".join(vtt_content)

    def _seconds_to_srt_time(self, seconds: float,
    ) -> str:
        """Convert seconds to SRT time format (HH:MM:SS,mmm)."""
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        milliseconds = int((seconds % 1) * 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"

    def _seconds_to_vtt_time(self, seconds: float,
    ) -> str:
        """Convert seconds to WebVTT time format (HH:MM:SS.mmm)."""
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        milliseconds = int((seconds % 1) * 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"