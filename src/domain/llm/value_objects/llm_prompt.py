"""LLM Prompt Value Object."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LLMPrompt:
    """Value object for LLM prompt.
    
    Represents a prompt for LLM inference with validation and business rules.
    """
    
    value: str
    
    def __post_init__(self) -> None:
        """Validate prompt after initialization."""
        if not self.value or not self.value.strip():
            msg = "Prompt cannot be empty"
            raise ValueError(msg)
        
        if len(self.value) > 10000:
            msg = "Prompt too long (max 10000 characters)"
            raise ValueError(msg)
        
        # Check for basic prompt structure
        if len(self.value.strip()) < 10:
            msg = "Prompt too short (min 10 characters)"
            raise ValueError(msg)
    
    def __str__(self) -> str:
        """String representation of prompt."""
        return self.value
    
    def __repr__(self) -> str:
        """Representation of prompt."""
        return f"LLMPrompt(value='{self.value[:50]}{'...' if len(self.value) > 50 else ''}')"
    
    def __eq__(self, other: object) -> bool:
        """Equality comparison."""
        if not isinstance(other, LLMPrompt):
            return False
        return self.value == other.value
    
    def __hash__(self) -> int:
        """Hash for prompt."""
        return hash(self.value)
    
    @property
    def word_count(self) -> int:
        """Get the word count of the prompt."""
        return len(self.value.split())
    
    @property
    def token_estimate(self) -> int:
        """Estimate the number of tokens in the prompt."""
        # Rough estimate: 1 token ≈ 4 characters for English text
        return len(self.value) // 4
    
    @property
    def is_system_prompt(self) -> bool:
        """Check if this looks like a system prompt."""
        lower_prompt = self.value.lower()
        system_indicators = [
            "you are", "you're", "system:", "instruction:", 
            "role:", "assistant:", "ai:", "bot:",
        ]
        return any(indicator in lower_prompt for indicator in system_indicators)
    
    @property
    def is_user_prompt(self) -> bool:
        """Check if this looks like a user prompt."""
        return not self.is_system_prompt
    
    @property
    def contains_placeholders(self) -> bool:
        """Check if the prompt contains placeholder variables."""
        import re
        placeholder_pattern = r"\{\w+\}|\$\w+|\{\{[^}]+\}\}"
        return bool(re.search(placeholder_pattern, self.value))
    
    def replace_placeholders(self, **kwargs: str) -> LLMPrompt:
        """Replace placeholders in the prompt with provided values."""
        result = self.value
        for key, value in kwargs.items():
            # Replace various placeholder formats
            result = result.replace(f"{{{key}}}", str(value))
            result = result.replace(f"${{{key}}}", str(value))
            result = result.replace("${key}", str(value))
        return LLMPrompt(result)
    
    @classmethod
    def from_string(cls, value: str) -> LLMPrompt:
        """Create LLMPrompt from string."""
        return cls(value.strip())
    
    @classmethod
    def system_prompt(cls, content: str) -> LLMPrompt:
        """Create a system prompt."""
        if not content.strip().lower().startswith(("you are", "system:", "instruction:")):
            content = f"You are {content}"
        return cls(content)
    
    @classmethod
    def user_prompt(cls, content: str) -> LLMPrompt:
        """Create a user prompt."""
        return cls(content) 