"""Resource helper utilities for Presentation layer.

Centralizes resource resolution and existence checks to keep UI classes lean.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from PyQt6.QtGui import QIcon, QPixmap


class IResourceService(Protocol):
    def get_resource_path(self, relative_path: str) -> str: ...
    # Implementations may optionally provide this; we will use it when available
    def resource_exists(self, relative_path: str) -> bool: ...  # type: ignore[override]


def try_get_path(resource_service: IResourceService, relative_path: str) -> str | None:
    """Resolve a resource path if it exists on disk; return None otherwise."""
    # Prefer adapter-provided existence check if present
    try:
        if hasattr(resource_service, "resource_exists") and callable(resource_service.resource_exists):
            exists = resource_service.resource_exists(relative_path)
            if exists:
                return resource_service.get_resource_path(relative_path)
            return None
    except Exception:
        # Fallback to local check below
        pass

    path = resource_service.get_resource_path(relative_path)
    return path if path and Path(path).exists() else None


def try_get_icon(resource_service: IResourceService, relative_path: str) -> QIcon | None:
    """Create a QIcon from a resource if available."""
    path = try_get_path(resource_service, relative_path)
    return QIcon(path) if path else None


def try_get_pixmap(resource_service: IResourceService, relative_path: str) -> QPixmap | None:
    """Create a QPixmap from a resource if available."""
    path = try_get_path(resource_service, relative_path)
    return QPixmap(path) if path else None


