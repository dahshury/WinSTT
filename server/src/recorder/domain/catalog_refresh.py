"""Runtime HuggingFace catalog refresh — language whitelist fetcher.

A leaner sibling of ``scripts/refresh_catalog.py`` for use inside the
running server: only fetches the editorial fields the upstream model card
is authoritative for (currently ``languages``), and stays defensive so a
slow or failing HF call never blocks server startup.

The script-side counterpart still owns release-time refresh of
``available_quantizations`` and ``param_count`` — those depend on a
filename scan + sidecar measurements and don't change between releases
often enough to warrant runtime re-fetch.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from src.recorder.domain.model_registry import ModelInfo

logger = logging.getLogger(__name__)

#: For Whisper-family entries the onnx-community / Xenova mirrors don't
#: propagate language metadata in their model cards. Fall back to the
#: openai upstream — every Whisper ONNX export wraps the same 99-language
#: decoder head. ``.en`` checkpoints are special-cased separately.
_FAMILY_LANGUAGE_REFERENCE: dict[str, str] = {
    "whisper": "openai/whisper-tiny",
    "lite-whisper": "openai/whisper-tiny",
}


def _ends_with_en(*values: str | None) -> bool:
    return any((v or "").endswith(".en") for v in values)


def _is_english_only_whisper(info: ModelInfo) -> bool:
    """Whether ``info`` is a Whisper ``.en`` checkpoint (English-only head)."""
    if info.family not in {"whisper", "lite-whisper"}:
        return False
    return _ends_with_en(info.id, info.onnx_model_name)


def _model_repos_lookup(onnx_model_name: str) -> str | None:
    try:
        from onnx_asr.resolver import model_repos
    except ImportError:  # pragma: no cover - onnx_asr is always installed at runtime
        return None
    return model_repos.get(onnx_model_name)


def _resolve_hf_repo(onnx_model_name: str | None) -> str | None:
    """Map an entry's ``onnx_model_name`` to a real HF ``org/repo`` id."""
    if not onnx_model_name:
        return None
    if "/" in onnx_model_name:
        return onnx_model_name
    return _model_repos_lookup(onnx_model_name)


def _hf_model_info(repo_id: str) -> object | None:
    """Fetch HF ``model_info`` defensively; ``None`` on import/network failure."""
    try:
        from huggingface_hub import HfApi
    except ImportError:  # pragma: no cover - huggingface_hub is always installed at runtime
        return None
    try:
        return HfApi().model_info(repo_id)
    except Exception as exc:
        logger.debug("model_info(%r) failed: %s: %s", repo_id, type(exc).__name__, exc)
        return None


def _model_card_language(repo_id: str) -> object | None:
    """Return the raw ``card_data.language`` value for a HF repo, or ``None``."""
    info = _hf_model_info(repo_id)
    card = getattr(info, "card_data", None)
    return getattr(card, "language", None)


def _str_items(values: list[object]) -> list[str]:
    return [str(x) for x in values if isinstance(x, str)]


def _normalize_language(raw: object | None) -> list[str] | None:
    """Coerce a model card ``language`` field into a ``list[str]`` or ``None``."""
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return _str_items(raw)
    return None


def _fetch_card_languages(repo_id: str) -> list[str] | None:
    """Return the ``card_data.language`` list for a HF repo, or ``None``."""
    return _normalize_language(_model_card_language(repo_id))


def _languages_for(
    info: ModelInfo,
    cache: dict[str, list[str] | None] | None = None,
) -> list[str] | None:
    """Authoritative language whitelist for ``info``, or ``None`` to skip.

    ``.en`` Whisper variants are pinned to ``["en"]`` since the mirror
    metadata is silent and the decoder cannot emit other languages.
    Whisper-family entries route through the openai reference repo
    (mirrors don't propagate the field). Everything else uses the
    resolved repo's own model-card data.

    ``cache`` memoizes the per-repo HF fetch within a single refresh:
    many catalog entries share one reference repo (every Whisper variant
    resolves to ``openai/whisper-tiny``), so without it the same
    ``model_info`` GET fires once per entry. Passing a shared dict
    collapses those to a single network call. A cached ``None`` (failed
    or empty card) is honoured too, so a flaky repo isn't re-hit mid-run.
    """
    if _is_english_only_whisper(info):
        return ["en"]
    repo = _reference_repo_for(info)
    if repo is None:
        return None
    if cache is None:
        return _fetch_card_languages(repo)
    if repo not in cache:
        cache[repo] = _fetch_card_languages(repo)
    return cache[repo]


def _reference_repo_for(info: ModelInfo) -> str | None:
    """Pick the HF repo whose model card carries ``info``'s languages."""
    fallback = _FAMILY_LANGUAGE_REFERENCE.get(info.family)
    if fallback is not None:
        return fallback
    return _resolve_hf_repo(info.onnx_model_name)


def fetch_language_overlay(models: list[ModelInfo]) -> dict[str, dict[str, list[str]]]:
    """Build a ``{model_id: {"languages": [...]}}`` overlay for ``models``.

    Only entries whose HF metadata could actually be fetched make it into
    the result — that way a partial refresh writes a partial overlay
    instead of clobbering bundled data with empty lists. Caller persists
    via :func:`catalog_overlay.save_overlay` and merges into a live
    :class:`ModelCatalog`.
    """
    overlay: dict[str, dict[str, list[str]]] = {}
    repo_cache: dict[str, list[str] | None] = {}
    for info in models:
        langs = _languages_for(info, repo_cache)
        if not langs:
            continue
        overlay[info.id] = {"languages": sorted(set(langs))}
    return overlay
