"""
Language Value Object

Represents language codes and validation for transcription.
Extracted from model configuration and language selection logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from src_refactored.domain.common.value_object import ValueObject


class LanguageCode(Enum):
    """ISO 639-1 language codes supported by the transcription models."""
    ENGLISH = "en"
    SPANISH = "es"
    FRENCH = "fr"
    GERMAN = "de"
    ITALIAN = "it"
    PORTUGUESE = "pt"
    RUSSIAN = "ru"
    JAPANESE = "ja"
    KOREAN = "ko"
    CHINESE = "zh"
    HINDI = "hi"
    ARABIC = "ar"
    DUTCH = "nl"
    POLISH = "pl"
    SWEDISH = "sv"
    NORWEGIAN = "no"
    DANISH = "da"
    FINNISH = "fi"
    AUTO_DETECT = "auto"


@dataclass(frozen=True)
class Language(ValueObject):
    """
    Value object for language specification with validation.
    Supports both explicit language codes and auto-detection.
    """
    code: LanguageCode
    name: str = ""
    confidence: float = 1.0

    def __post_init__(self,
    ):
        if not 0.0 <= self.confidence <= 1.0:
            msg = f"Language confidence must be between 0.0 and 1.0, got: {self.confidence}"
            raise ValueError(msg)

        # Set default name if not provided
        if not self.name:
            object.__setattr__(self, "name", self._get_default_name())

    def _get_default_name(self) -> str:
        """Get default human-readable name for the language."""
        name_mapping = {
            LanguageCode.ENGLISH: "English",
            LanguageCode.SPANISH: "Spanish",
            LanguageCode.FRENCH: "French",
            LanguageCode.GERMAN: "German",
            LanguageCode.ITALIAN: "Italian",
            LanguageCode.PORTUGUESE: "Portuguese",
            LanguageCode.RUSSIAN: "Russian",
            LanguageCode.JAPANESE: "Japanese",
            LanguageCode.KOREAN: "Korean",
            LanguageCode.CHINESE: "Chinese",
            LanguageCode.HINDI: "Hindi",
            LanguageCode.ARABIC: "Arabic",
            LanguageCode.DUTCH: "Dutch",
            LanguageCode.POLISH: "Polish",
            LanguageCode.SWEDISH: "Swedish",
            LanguageCode.NORWEGIAN: "Norwegian",
            LanguageCode.DANISH: "Danish",
            LanguageCode.FINNISH: "Finnish",
            LanguageCode.AUTO_DETECT: "Auto-detect",
        }
        return name_mapping.get(self.code, self.code.value)

    @property
    def is_auto_detect(self) -> bool:
        """Check if this is auto-detection mode."""
        return self.code == LanguageCode.AUTO_DETECT

    @property
    def is_rtl(self) -> bool:
        """Check if language is right-to-left."""
        rtl_languages = {LanguageCode.ARABIC}
        return self.code in rtl_languages

    @property
    def is_cjk(self) -> bool:
        """Check if language uses CJK (Chinese, Japanese, Korean) script."""
        cjk_languages = {LanguageCode.CHINESE, LanguageCode.JAPANESE, LanguageCode.KOREAN}
        return self.code in cjk_languages

    @classmethod
    def from_code(cls, code: str, confidence: float = 1.0) -> Language:
        """Create Language from ISO code string."""
        try:
            language_code = LanguageCode(code.lower(),
    )
            return cls(code=language_code, confidence=confidence)
        except ValueError:
            # Default to auto-detect for unknown codes
            return cls(code=LanguageCode.AUTO_DETECT, confidence=0.0)

    @classmethod
    def auto_detect(cls) -> Language:
        """Create auto-detection language."""
        return cls(code=LanguageCode.AUTO_DETECT, confidence=0.0)

    @classmethod
    def english(cls) -> Language:
        """Create English language with high confidence."""
        return cls(code=LanguageCode.ENGLISH, confidence=1.0)

    def with_confidence(self, confidence: float,
    ) -> Language:
        """Create new Language with updated confidence."""
        return Language(code=self.code, name=self.name, confidence=confidence)