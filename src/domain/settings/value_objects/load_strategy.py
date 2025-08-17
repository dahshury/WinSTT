"""Load Strategy Value Object."""

from __future__ import annotations

from enum import Enum


class LoadStrategy(Enum):
    """Enumeration of configuration loading strategies."""
    
    STRICT = "strict"
    """Strict loading - fail on any validation errors."""
    
    OVERRIDE = "override"
    """Override loading - merge and override existing settings."""
    
    MERGE = "merge"
    """Merge loading - combine with existing settings."""
    
    REPLACE = "replace"
    """Replace loading - completely replace existing settings."""
    
    VALIDATE_ONLY = "validate_only"
    """Validate only - check settings without applying."""

