"""Domain types for user-provided custom ONNX model bundles.

The catalog merges these entries alongside the bundled :data:`catalog.json`
list so the picker can surface both first-party and user-dropped models. The
type lives in domain because it's pure data — the infrastructure scanner
(``custom_model_scanner.py``) produces these entries from disk, and
:class:`ModelCatalog` consumes them without ever touching the filesystem.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class CustomModelEntry:
    """One discovered custom-model folder, valid or broken.

    ``valid=True`` entries surface as a normal catalog row with
    ``family="custom"`` and ``id="custom-{slug}"``. ``valid=False`` entries
    surface as greyed-out rows whose tooltip is ``error_message`` — the user
    sees what's missing without having to inspect the folder by hand.

    ``slug`` is the directory name. ``display_name`` is the HF
    ``_name_or_path`` (when present) or a title-cased version of the slug.
    """

    slug: str
    path: Path
    valid: bool
    display_name: str
    description: str
    error_message: str = ""
    config: dict[str, object] = field(default_factory=dict)


__all__ = ["CustomModelEntry"]
