"""Filesystem scanner for user-provided ONNX Whisper model folders.

Discovers HuggingFace-style ONNX model bundles dropped into
``{custom_models_dir}/{slug}/`` and validates them against a contract so the
catalog can surface either a working entry (registered with ``family="custom"``
and ``id="custom-{slug}"``) or a greyed-out broken entry the UI can render
with a tooltip explaining what's missing.

Lives in :mod:`infrastructure` because it does live filesystem I/O. The
domain model registry consumes the typed result
(:class:`~src.recorder.domain.custom_models.CustomModelEntry`) without ever
touching the filesystem directly.

Contract — a custom model folder must contain:

- An encoder ONNX (``encoder.onnx`` OR ``encoder_model.onnx``).
- A decoder ONNX (``decoder_model.onnx`` OR ``decoder_model_merged.onnx``).
- ``tokenizer.json`` (HuggingFace tokenizers format).
- ``config.json`` (HuggingFace model config; ``model_type`` required;
  ``_name_or_path`` optional and used for the display name).

Optional files (kept around verbatim, never required):

- ``preprocessor_config.json``
- ``generation_config.json``
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from src.recorder.domain.custom_models import CustomModelEntry

logger = logging.getLogger(__name__)


#: Acceptable filenames for the encoder ONNX. onnx-community publishes
#: ``encoder_model.onnx``; Optimum-style exports use the shorter
#: ``encoder.onnx``. Either is fine.
_ENCODER_CANDIDATES: tuple[str, ...] = ("encoder.onnx", "encoder_model.onnx")

#: Acceptable filenames for the decoder ONNX. ``decoder_model_merged.onnx`` is
#: the unified past/no-past graph onnx-asr prefers; ``decoder_model.onnx`` is
#: the legacy no-past export. Either resolves cleanly through onnx-asr's
#: Whisper adapter.
_DECODER_CANDIDATES: tuple[str, ...] = ("decoder_model.onnx", "decoder_model_merged.onnx")

#: Required HF-style metadata files. ``tokenizer.json`` must be the unified
#: tokenizers format (not the legacy ``vocab.json``+``merges.txt`` pair).
_TOKENIZER_FILE: str = "tokenizer.json"
_CONFIG_FILE: str = "config.json"


def _humanize_slug(slug: str) -> str:
    """Turn ``my-custom-whisper`` into ``My Custom Whisper`` for the picker label.

    A user who didn't ship a ``_name_or_path``
    in ``config.json`` still gets a tidy display label without us inventing
    metadata they didn't provide. Hyphens and underscores both collapse to
    spaces so either casing convention works.
    """
    parts = [p for p in slug.replace("_", "-").split("-") if p]
    return " ".join(word.capitalize() for word in parts) if parts else slug


def _find_one_of(directory: Path, candidates: tuple[str, ...]) -> Path | None:
    """Return the first existing file from ``candidates`` inside ``directory``.

    Used to support multiple equivalent HF export filenames (the encoder ONNX
    has two valid names, the decoder ONNX has two valid names). Returns
    ``None`` if none of the candidates exist.
    """
    for name in candidates:
        candidate = directory / name
        if candidate.is_file():
            return candidate
    return None


def _format_missing(directory: Path, candidates: tuple[str, ...]) -> str:
    """Human-readable "missing X" message naming the first canonical filename.

    Lists only the first candidate to keep the tooltip short; the docs page
    enumerates every accepted alias.
    """
    return f"missing {candidates[0]} in {directory.name}"


def _load_config(directory: Path) -> tuple[dict[str, object] | None, str]:
    """Return ``(config, error_message)`` from ``{directory}/config.json``.

    ``error_message`` is empty on success. Missing / unreadable / non-JSON /
    non-object configs all produce a distinct message so a broken entry's
    tooltip points the user at the actual problem.
    """
    config_path = directory / _CONFIG_FILE
    if not config_path.is_file():
        return None, _format_missing(directory, (_CONFIG_FILE,))
    try:
        raw = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        return None, f"unreadable {_CONFIG_FILE}: {exc}"
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, f"malformed {_CONFIG_FILE}: {exc.msg}"
    if not isinstance(parsed, dict):
        return None, f"malformed {_CONFIG_FILE}: top-level value must be an object"
    return parsed, ""


def _validate_folder(directory: Path) -> tuple[bool, str, dict[str, object]]:
    """Validate ``directory`` against the contract.

    Returns ``(valid, error_message, config_dict)``. ``config_dict`` is the
    parsed ``config.json`` body when readable (so :func:`scan_custom_models`
    can extract ``_name_or_path`` even on broken entries that just happen to
    be missing weights).
    """
    if _find_one_of(directory, _ENCODER_CANDIDATES) is None:
        return False, _format_missing(directory, _ENCODER_CANDIDATES), {}
    if _find_one_of(directory, _DECODER_CANDIDATES) is None:
        return False, _format_missing(directory, _DECODER_CANDIDATES), {}
    tokenizer = directory / _TOKENIZER_FILE
    if not tokenizer.is_file():
        return False, _format_missing(directory, (_TOKENIZER_FILE,)), {}
    config, config_error = _load_config(directory)
    if config_error:
        return False, config_error, config or {}
    assert config is not None  # narrowing — _load_config returns ``""`` only with a dict
    if not isinstance(config.get("model_type"), str) or not config["model_type"]:
        return False, f"{_CONFIG_FILE} missing required 'model_type' field", config
    return True, "", config


def _display_name(slug: str, config: dict[str, object]) -> str:
    """Pick the best display label given the slug + parsed config dict.

    HuggingFace conventionally writes the repo's full path into
    ``_name_or_path`` (e.g. ``openai/whisper-tiny.en``). We use the trailing
    segment after the slash so a custom export of ``openai/whisper-base``
    shows up as ``Whisper Base`` rather than ``Openai/Whisper Base``.
    Falls back to a humanized slug when the field is absent.
    """
    raw = config.get("_name_or_path")
    if isinstance(raw, str) and raw.strip():
        tail = raw.rsplit("/", 1)[-1].strip()
        if tail:
            return tail
    return _humanize_slug(slug)


def _description_for(entry_path: Path, *, valid: bool, error_message: str) -> str:
    """Tooltip / description text shown alongside the model row.

    Valid entries point the user at the on-disk folder so they know where to
    swap the weights out. Broken entries lead with the error so the failure
    mode is obvious at a glance.
    """
    if valid:
        return f"Custom model in {entry_path}"
    return f"Broken custom model in {entry_path}: {error_message}"


def _build_entry(directory: Path) -> CustomModelEntry:
    """Validate ``directory`` and assemble the typed entry for the registry."""
    slug = directory.name
    valid, error_message, config = _validate_folder(directory)
    display_name = _display_name(slug, config)
    description = _description_for(directory, valid=valid, error_message=error_message)
    return CustomModelEntry(
        slug=slug,
        path=directory,
        valid=valid,
        display_name=display_name,
        description=description,
        error_message=error_message,
        config=config,
    )


def scan_custom_models(custom_dir: Path | str | None) -> list[CustomModelEntry]:
    """Scan ``custom_dir`` for HF-style ONNX bundles.

    Returns one :class:`CustomModelEntry` per immediate subdirectory of
    ``custom_dir``, with ``valid`` set per the contract above. The function
    never raises:

    - ``None`` / missing / non-directory paths yield ``[]`` (nothing to scan
      is a valid configuration — most users don't have custom models).
    - Filesystem errors while listing ``custom_dir`` are logged and produce
      ``[]`` (we'd rather show no custom models than crash the catalog).
    - Hidden directories (leading ``.``) are skipped — a partial download or
      ``.DS_Store`` style entry isn't a real bundle.

    Output is sorted by slug for deterministic catalog ordering.
    """
    if custom_dir is None:
        return []
    path = Path(custom_dir)
    if not path.is_dir():
        return []
    try:
        children = sorted(path.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        logger.warning("Failed to list custom models dir %s: %s", path, exc)
        return []
    entries: list[CustomModelEntry] = []
    for child in children:
        if not child.is_dir():
            continue
        if child.name.startswith("."):
            continue
        entry = _build_entry(child)
        if entry.valid:
            logger.info("Discovered custom model: %s (%s)", entry.slug, child)
        else:
            logger.warning(
                "Skipping invalid custom model %s in %s: %s",
                entry.slug,
                child,
                entry.error_message,
            )
        entries.append(entry)
    return entries


__all__ = ["scan_custom_models"]
