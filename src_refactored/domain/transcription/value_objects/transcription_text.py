"""
Transcription Text Value Object

Represents transcribed text with validation and formatting rules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from src_refactored.domain.common.value_object import ValueObject


@dataclass(frozen=True)
class TranscriptionText(ValueObject):
    """
    Value object for transcribed text with validation and business rules.
    
    Handles text processing, formatting, and validation for transcription results.
    """
    content: str
    is_final: bool = True

    def __post_init__(self,
    ) -> None:
        # Allow empty content for streaming scenarios
        if self.content is None:
            object.__setattr__(self, "content", "")

        # Validate maximum length (prevent memory issues)
        if len(self.content) > 1_000_000:  # 1 million characters
            msg = f"Transcription text too long: {len(self.content)} characters"
            raise ValueError(msg)

    @property
    def is_empty(self) -> bool:
        """Check if transcription text is empty."""
        return not self.content.strip()

    @property
    def word_count(self) -> int:
        """Count words in the transcription."""
        if self.is_empty:
            return 0
        return len(self.content.split())

    @property
    def character_count(self) -> int:
        """Count characters in the transcription."""
        return len(self.content)

    @property
    def character_count_no_spaces(self) -> int:
        """Count characters excluding spaces."""
        return len(self.content.replace(" ", ""))

    @property
    def sentence_count(self) -> int:
        """Count sentences in the transcription."""
        if self.is_empty:
            return 0

        # Split by sentence terminators
        sentences = re.split(r"[.!?]+", self.content)
        # Filter out empty sentences
        sentences = [s for s in sentences if s.strip()]
        return len(sentences)

    @property
    def paragraph_count(self) -> int:
        """Count paragraphs in the transcription."""
        if self.is_empty:
            return 0

        paragraphs = self.content.split("\n\n")
        paragraphs = [p for p in paragraphs if p.strip()]
        return len(paragraphs)

    def get_sentences(self) -> list[str]:
        """Extract individual sentences from the transcription."""
        if self.is_empty:
            return []

        # Split by sentence terminators and clean up
        sentences = re.split(r"(?<=[.!?])\s+", self.content)
        return [s.strip() for s in sentences if s.strip()]

    def apply_formatting_rules(self) -> TranscriptionText:
        """
        Apply business rules for text formatting.
        
        Rules:
        - Convert "New paragraph." to actual paragraph breaks
        - Normalize whitespace
        - Capitalize sentences
        """
        formatted_content = self.content

        # Replace "New paragraph." with paragraph breaks
        formatted_content = formatted_content.replace("New paragraph.", "\n\n")

        # Normalize whitespace (remove extra spaces, normalize line endings)
        formatted_content = re.sub(r"\s+", " ", formatted_content)
        formatted_content = formatted_content.replace("\n ", "\n")
        formatted_content = formatted_content.strip()

        # Capitalize first letter of sentences
        sentences = re.split(r"(?<=[.!?])\s+", formatted_content)
        capitalized_sentences = []

        for sentence in sentences:
            if sentence.strip():
                # Capitalize first letter
                sentence = sentence.strip()
                if sentence:
                    sentence = sentence[0].upper() + sentence[1:]
                capitalized_sentences.append(sentence)

        if capitalized_sentences:
            formatted_content = " ".join(capitalized_sentences,
    )

        return TranscriptionText(content=formatted_content, is_final=self.is_final)

    def truncate(self, max_length: int, suffix: str = "...") -> TranscriptionText:
        """Truncate text to maximum length."""
        if max_length < 0:
            msg = f"Max length cannot be negative: {max_length}"
            raise ValueError(msg)

        if len(self.content) <= max_length:
            return self

        truncated = self.content[:max_length - len(suffix,
    )] + suffix
        return TranscriptionText(content=truncated, is_final=self.is_final)

    def append(self, other_text: str,
    ) -> TranscriptionText:
        """Append text to create new TranscriptionText."""
        new_content = self.content + other_text
        return TranscriptionText(content=new_content, is_final=self.is_final)

    def as_interim(self) -> TranscriptionText:
        """Create interim version (not final) of this transcription."""
        return TranscriptionText(content=self.content, is_final=False)

    def as_final(self) -> TranscriptionText:
        """Create final version of this transcription."""
        return TranscriptionText(content=self.content, is_final=True)

    @classmethod
    def empty(cls) -> TranscriptionText:
        """Create empty transcription text."""
        return cls(content="", is_final=False)

    @classmethod
    def interim(cls, content: str,
    ) -> TranscriptionText:
        """Create interim transcription text."""
        return cls(content=content, is_final=False)

    @classmethod
    def final(cls, content: str,
    ) -> TranscriptionText:
        """Create final transcription text."""
        return cls(content=content, is_final=True)

    def contains_speech_commands(self) -> bool:
        """Check if text contains speech-to-text commands."""
        commands = [
            "new paragraph",
            "period",
            "comma",
            "question mark",
            "exclamation point",
        ]
        content_lower = self.content.lower()
        return any(cmd in content_lower for cmd in commands)

    def estimate_reading_time_minutes(self, words_per_minute: int = 200) -> float:
        """Estimate reading time in minutes."""
        if words_per_minute <= 0:
            msg = f"Words per minute must be positive: {words_per_minute}"
            raise ValueError(msg,
    )

        return self.word_count / words_per_minute