"""Key combination value object for settings domain."""

from __future__ import annotations

from dataclasses import dataclass

from src_refactored.domain.common import ValueObject


@dataclass(frozen=True)
class KeyCombination(ValueObject):
    """Value object for keyboard key combinations."""

    modifiers: list[str]
    key: str

    def _get_equality_components(self) -> tuple[object, ...]:
        """Get components for equality comparison."""
        return (tuple(self.modifiers), self.key)

    def __post_init__(self) -> None:
        """Validate key combination after initialization."""
        valid_modifiers = {"CTRL", "ALT", "SHIFT", "META", "CMD"}

        for modifier in self.modifiers:
            if modifier.upper() not in valid_modifiers:
                msg = f"Invalid modifier: {modifier}"
                raise ValueError(msg)

        if not self.key or not self.key.strip():
            msg = "Key cannot be empty"
            raise ValueError(msg)

        # Ensure modifiers are unique and uppercase
        unique_modifiers = list({mod.upper() for mod in self.modifiers})
        object.__setattr__(self, "modifiers", sorted(unique_modifiers))
        object.__setattr__(self, "key", self.key.upper())

    @classmethod
    def from_string(cls, key_string: str,
    ) -> KeyCombination:
        """Create from string like 'CTRL+ALT+A' or 'A+ALT+CTRL'."""
        if not key_string or not key_string.strip():
            msg = "Key combination string cannot be empty"
            raise ValueError(msg)

        parts = [part.strip().upper() for part in key_string.split("+")]
        if len(parts) < 1:
            msg = "Invalid key combination string"
            raise ValueError(msg)

        # Identify modifiers vs the actual key
        valid_modifiers = {"CTRL", "ALT", "SHIFT", "META", "CMD"}
        modifiers = []
        key = None
        
        # Find all valid modifiers and the key
        for part in parts:
            if part in valid_modifiers:
                modifiers.append(part)
            elif key is None or len(key) <= 4:
                key = part
        
        # If no key found, use the last part
        if key is None:
            key = parts[-1]
            modifiers = [p for p in parts[:-1] if p in valid_modifiers]
        
        return cls(modifiers=modifiers, key=key)

    def to_string(self) -> str:
        """Convert to string representation."""
        if self.modifiers:
            return "+".join([*self.modifiers, self.key])
        return self.key

    def is_valid_for_recording(self) -> bool:
        """Check if this key combination is valid for recording hotkey.

        Allow either:
        - At least one modifier (CTRL/ALT/SHIFT/META/CMD)
        - Or standalone function keys (F1..F35) which are common for PTT
        """
        if len(self.modifiers) > 0:
            return True
        key_upper = self.key.upper().strip()
        if key_upper.startswith("F") and key_upper[1:].isdigit():
            return True
        return False

    def has_modifier(self, modifier: str,
    ) -> bool:
        """Check if the combination contains a specific modifier."""
        return modifier.upper() in self.modifiers

    def __str__(self) -> str:
        """String representation."""
        return self.to_string()