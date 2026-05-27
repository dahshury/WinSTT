"""Refresh ``src/recorder/domain/catalog.json`` from HuggingFace + onnx-asr.

Run from ``server/``:

  uv run --no-sync python scripts/refresh_catalog.py
  uv run --no-sync python scripts/refresh_catalog.py --offline  # skip HF
  uv run --no-sync python scripts/refresh_catalog.py --dry-run   # don't write

For every model in the existing catalog the script:

* Resolves the canonical HF repo via :mod:`onnx_asr.resolver` (the upstream
  library that consumes these models is the authoritative source — we never
  duplicate the alias→repo table on our side).
* Lists files on the HF hub for that repo and derives
  ``available_quantizations`` from the ONNX filename suffixes the repo
  actually ships. A curation filter drops quants known to be broken in
  practice (see :data:`_KNOWN_BROKEN_QUANTS`).
* Refreshes ``param_count`` from ``scripts/_model_param_counts.json``
  (produced by ``measure_model_params.py``) when an entry is missing or
  stale.
* Refreshes ``languages`` from the HuggingFace model card's
  ``card_data.language`` for the resolved repo. Whisper-family entries
  fall back to ``openai/whisper-tiny`` (the onnx-community / Xenova
  mirrors don't propagate language metadata; the underlying Whisper
  decoder is the same 99-language head). ``.en`` Whisper variants are
  forced to ``["en"]`` since the mirror metadata is silent and the
  decoder is English-only by construction.
* Preserves the editorial fields (display_name, description,
  supports_language_detection, supports_realtime, family).

The script is idempotent — re-running on a clean catalog produces a
byte-identical file. Adding a new model means appending an entry to the
catalog JSON with at least ``id``, ``onnx_model_name``, ``family``, and
``display_name``; the script fills in the rest on the next run.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).parent
SERVER_ROOT = SCRIPT_DIR.parent
CATALOG_PATH = SERVER_ROOT / "src" / "recorder" / "domain" / "catalog.json"
PARAM_COUNTS_PATH = SCRIPT_DIR / "_model_param_counts.json"

# Quantization suffixes that may appear in ONNX filenames. Longest-match
# first so ``_q4f16`` isn't mis-parsed as ``_q4``. Empty string is the
# default un-suffixed export. The separator before the suffix may be ``_``
# (onnx-community Whisper layout) or ``.`` (istupakov NeMo / GigaAM layout
# — e.g. ``encoder-model.int8.onnx``).
_QUANT_SUFFIXES: tuple[str, ...] = ("q4f16", "bnb4", "int8", "fp16", "uint8", "q4")
_QUANT_RE = re.compile(r"[._](" + "|".join(_QUANT_SUFFIXES) + r")\.onnx$")
#: Same suffix detector but accepts both external-data tail conventions
#: too: ``.onnx_data`` (onnx-community) and ``.onnx.data`` (istupakov
#: NeMo / GigaAM). Used by :func:`_refresh_sizes` so a model whose tensors
#: live in a sibling weight-data file get attributed to the same quant.
_QUANT_WEIGHT_RE = re.compile(r"[._](" + "|".join(_QUANT_SUFFIXES) + r")\.onnx(?:_data|\.data)?$")

#: For Whisper-family repos, onnx-asr's ``WhisperHf`` adapter only loads
#: ``decoder_model_merged*.onnx`` — the unmerged ``decoder_model.onnx`` /
#: ``decoder_with_past_model.onnx`` pair is ignored. So a Xenova mirror
#: that ships ``decoder_model_int8.onnx`` but no merged equivalent should
#: NOT mark int8 as available. The HF scan filters Whisper-family files
#: through this matcher; for other families everything counts.
_WHISPER_USABLE_FILE_RE = re.compile(r"(?:^|/)decoder_model_merged(?:[._][a-z0-9]+)?\.onnx$")

# Curation filter — quants observed broken in practice for a family.
# Drops them from ``available_quantizations`` even when the HF repo ships
# the files, so the picker doesn't tempt users with non-working choices.
# See the long comment that used to live at the top of model_registry.py
# (``_WHISPER_QUANTS``) for the per-family forensics.
_KNOWN_BROKEN_QUANTS: dict[str, frozenset[str]] = {
    # onnx-community/whisper-* repos: int8/uint8 fail on missing decoder
    # QDQ scale tensors; q4f16 isn't actually shipped despite the
    # filename pattern.
    "whisper": frozenset({"int8", "uint8", "q4f16"}),
}

# Per-repo override — broken-quant rules that don't follow the family key.
# The picker now groups Lite-Whisper under the ``whisper`` family for UX
# reasons, but the upstream onnx-community ``lite-whisper-*-ONNX`` repos
# have their own brokenness profile (fp16 works post the OnnxAsrTranscriber
# patch + EXTENDED workaround; everything else hallucinates or fails to
# load). Keyed by onnx_model_name prefix so id-vs-family classification
# can change in the picker without re-introducing broken quants.
_BROKEN_QUANTS_BY_REPO_PREFIX: dict[str, frozenset[str]] = {
    "onnx-community/lite-whisper-": frozenset({"int8", "uint8", "q4f16", "q4", "bnb4"}),
}


def _broken_quants_for(entry: dict[str, Any] | None) -> frozenset[str]:
    """Union of the family-level filter and any per-repo override for ``entry``."""
    if entry is None:
        return frozenset()
    family = str(entry.get("family", ""))
    broken = set(_KNOWN_BROKEN_QUANTS.get(family, frozenset()))
    onnx = str(entry.get("onnx_model_name") or "")
    for prefix, extras in _BROKEN_QUANTS_BY_REPO_PREFIX.items():
        if onnx.startswith(prefix):
            broken |= extras
    return frozenset(broken)


def _quantization_from_filename(name: str) -> str | None:
    """Return the quant suffix for an ONNX filename, or ``""`` for the default.

    Returns ``None`` when the filename isn't an ONNX file at all (so the
    caller can skip it). ``"encoder_model.onnx"`` → ``""``,
    ``"encoder_model_int8.onnx"`` → ``"int8"``, ``"config.json"`` → ``None``.
    """
    if not name.endswith(".onnx"):
        return None
    match = _QUANT_RE.search(name)
    return match.group(1) if match else ""


def _quantization_from_weight_filename(name: str) -> str | None:
    """Return the quant suffix for a weight filename (``.onnx`` or ``.onnx_data``).

    Mirrors :func:`_quantization_from_filename` but also accepts the
    external-data tail that large ONNX exports use for tensors. Needed
    by :func:`_refresh_sizes` so the bytes that live in a sibling
    ``*.onnx_data`` file get attributed to the same quantization bucket
    as the matching ``*.onnx`` graph.
    """
    if not (name.endswith(".onnx") or name.endswith(".onnx_data") or name.endswith(".onnx.data")):
        return None
    match = _QUANT_WEIGHT_RE.search(name)
    return match.group(1) if match else ""


#: Display order for quantizations in the picker. Default (full precision)
#: first, then by descending bit-width / decreasing usefulness — fp16 is
#: the most useful real-money quant on GPU; q4 / bnb4 are tiny-on-disk
#: niche choices; int8 / uint8 / q4f16 trail. Anything not in this list
#: appears at the end in alphabetical order (defensive fallback).
_QUANT_DISPLAY_ORDER: tuple[str, ...] = ("", "fp16", "q4", "bnb4", "int8", "uint8", "q4f16")


def _curate_quants(family: str, available: set[str], *, entry: dict[str, Any] | None = None) -> list[str]:
    """Apply the broken-quant filter for ``family`` and order the result.

    When ``entry`` is provided, per-repo overrides from
    :data:`_BROKEN_QUANTS_BY_REPO_PREFIX` are unioned with the family-level
    filter so we don't lose protection when the same repo gets re-grouped
    under a different ``family`` for UX reasons (lite-whisper now sits in
    the ``whisper`` group in the picker).
    Output order follows :data:`_QUANT_DISPLAY_ORDER` so the picker shows
    the most useful precision first regardless of which quants happen to
    be present on the repo.
    """
    broken = _KNOWN_BROKEN_QUANTS.get(family, frozenset()) if entry is None else _broken_quants_for(entry)
    kept = {q for q in available if q not in broken}
    if "" in available and "" not in broken:
        kept.add("")
    ordered: list[str] = [q for q in _QUANT_DISPLAY_ORDER if q in kept]
    leftover = sorted(kept - set(_QUANT_DISPLAY_ORDER))
    ordered.extend(leftover)
    return ordered or [""]


def _list_repo_files(repo_id: str) -> list[str] | None:
    """List filenames in a HF repo. Returns ``None`` on any network error.

    The caller treats ``None`` as "keep the existing ``available_quantizations``
    entry as-is" so an offline run doesn't clobber the catalog.
    """
    try:
        from huggingface_hub import HfApi
    except ImportError:
        return None
    try:
        return list(HfApi().list_repo_files(repo_id))
    except Exception as exc:
        print(f"  ! list_repo_files({repo_id!r}) failed: {type(exc).__name__}: {exc}")
        return None


#: Reference repo for families whose preferred mirror doesn't propagate
#: language metadata. All Whisper ONNX exports (onnx-community, Xenova,
#: istupakov) wrap the same OpenAI decoder head, so ``openai/whisper-tiny``
#: is authoritative for the 99-language whitelist — and the istupakov
#: mirror's incomplete ``['en', 'ru']`` claim is worse than the openai
#: source for ``whisper-base`` too.
_FAMILY_LANGUAGE_REFERENCE: dict[str, str] = {
    "whisper": "openai/whisper-tiny",
    "lite-whisper": "openai/whisper-tiny",
}


def _fetch_card_languages(repo_id: str) -> list[str] | None:
    """Return the language whitelist from a HF model card, or ``None``.

    The HuggingFace ``card_data.language`` field is the editorial truth
    for ASR repos (NVIDIA, istupakov, openai all populate it). Returns
    ``None`` on network errors or when the card lacks the field so the
    caller can fall back to the family-reference repo or skip refresh.
    Normalizes scalar strings to a single-element list to match the spec
    (some older cards use ``language: en`` instead of ``language: [en]``).
    """
    try:
        from huggingface_hub import HfApi
    except ImportError:
        return None
    try:
        info = HfApi().model_info(repo_id)
    except Exception as exc:
        print(f"  ! model_info({repo_id!r}) failed: {type(exc).__name__}: {exc}")
        return None
    card = info.card_data
    if card is None:
        return None
    raw = getattr(card, "language", None)
    if raw is None:
        return None
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [str(x) for x in raw if isinstance(x, str)]
    return None


def _is_english_only_whisper(entry: dict[str, Any]) -> bool:
    """Whether ``entry`` is a Whisper ``.en`` checkpoint (English-only head)."""
    if entry.get("family") != "whisper":
        return False
    model_id = str(entry.get("id", ""))
    onnx = str(entry.get("onnx_model_name") or "")
    return model_id.endswith(".en") or onnx.endswith(".en")


def _refresh_languages(entry: dict[str, Any], *, offline: bool) -> None:
    """Update ``entry["languages"]`` from HF model-card metadata, in-place.

    Skips the network call entirely when ``offline`` is true (preserves
    the bundled list). Family-reference fallback covers Whisper / Lite-
    Whisper mirrors that don't propagate ``language``. ``.en`` Whisper
    variants are pinned to ``["en"]`` regardless of HF input — the
    English decoder cannot emit other languages.
    """
    if offline:
        return
    if _is_english_only_whisper(entry):
        entry["languages"] = ["en"]
        return
    family = str(entry.get("family", ""))
    repo = _resolve_hf_repo(entry.get("onnx_model_name"))
    languages: list[str] | None = None
    fallback_repo = _FAMILY_LANGUAGE_REFERENCE.get(family)
    # For Whisper-family the mirror metadata is either missing or wrong
    # (istupakov/whisper-base-onnx claims ['en','ru'] though the model
    # is the same 99-language head as openai/whisper-base). Always use
    # the family reference; for other families, prefer the resolved repo.
    if fallback_repo is not None:
        languages = _fetch_card_languages(fallback_repo)
    elif repo is not None:
        languages = _fetch_card_languages(repo)
    if not languages:
        return
    entry["languages"] = sorted(set(languages))


def _resolve_hf_repo(onnx_model_name: str | None) -> str | None:
    """Map an entry's ``onnx_model_name`` to a real HF ``org/repo`` id.

    Reuses the upstream onnx-asr alias table (single source of truth);
    pass-through for already-slashed ids.
    """
    if not onnx_model_name:
        return None
    if "/" in onnx_model_name:
        return onnx_model_name
    try:
        from onnx_asr.resolver import model_repos
    except ImportError:
        return None
    return model_repos.get(onnx_model_name)


def _is_file_relevant(filename: str, family: str) -> bool:
    """Whether ``filename`` should drive ``available_quantizations`` for ``family``.

    Whisper / Lite-Whisper repos must restrict the scan to merged-decoder
    files because onnx-asr's adapter only loads those (Xenova mirrors ship
    plenty of unmerged variants the adapter ignores — counting them would
    over-promise quants that don't actually work). Other families have a
    flat filename layout, so any ``.onnx`` file is fair game.
    """
    if family in {"whisper", "lite-whisper"}:
        return bool(_WHISPER_USABLE_FILE_RE.search(filename))
    return filename.endswith(".onnx")


def _refresh_quants(entry: dict[str, Any], *, offline: bool) -> None:
    """Update ``entry["available_quantizations"]`` from HF, in-place.

    Skips the network call entirely when ``offline`` is true. When the
    repo can't be listed (network down, repo gated, no mapping), the
    existing value in the catalog is preserved.
    """
    if offline:
        return
    repo = _resolve_hf_repo(entry.get("onnx_model_name"))
    if repo is None:
        return
    files = _list_repo_files(repo)
    if files is None:
        return
    family = str(entry.get("family", ""))
    quants: set[str] = set()
    for f in files:
        if not _is_file_relevant(f, family):
            continue
        q = _quantization_from_filename(f)
        if q is not None:
            quants.add(q)
    if not quants:
        return
    entry["available_quantizations"] = _curate_quants(family, quants, entry=entry)


def _is_weight_relevant(filename: str, family: str) -> bool:
    """Whether ``filename`` counts toward a quant's download size.

    Mirrors :func:`_is_file_relevant`, but also admits external-data
    sidecars (``*.onnx_data`` for onnx-community, ``*.onnx.data`` for
    istupakov / NeMo) whose corresponding ``.onnx`` graph passes the
    family filter. The sidecars carry the actual weight tensors for
    large models and must be summed with the graph file.
    """
    if filename.endswith(".onnx"):
        return _is_file_relevant(filename, family)
    for tail in (".onnx_data", ".onnx.data"):
        if filename.endswith(tail):
            sibling = filename[: -len(tail)] + ".onnx"
            return _is_file_relevant(sibling, family)
    return False


def _sibling_size(sibling: object) -> int:
    """Best-effort byte count for an ``HfApi.model_info`` sibling.

    Falls back to ``sibling.lfs.size`` for LFS-tracked weight files where
    the top-level ``size`` field is ``None``. Returns ``0`` when neither
    is populated so the caller can skip the bucket.
    """
    size = getattr(sibling, "size", None)
    if not isinstance(size, int) or size <= 0:
        lfs = getattr(sibling, "lfs", None)
        size = getattr(lfs, "size", None) if lfs is not None else None
    return size if isinstance(size, int) and size > 0 else 0


def _refresh_sizes(entry: dict[str, Any], *, offline: bool) -> None:
    """Populate ``entry["size_bytes_by_quantization"]`` from HF, in-place.

    For each quantization the catalog advertises we sum the bytes of every
    ``.onnx`` / ``.onnx_data`` weight file matching that suffix, using the
    same family-aware filter the runtime cache probe uses. The resulting
    map drives the download-confirmation dialog so it can render an exact
    "Need to download: 78 MB" the moment it opens, instead of falling back
    to the "Size: unknown until headers fetched" placeholder.

    Skips the network call entirely in ``offline`` mode (preserves whatever
    was in the catalog). On any HF error the existing field is left alone
    so a flaky run doesn't clobber a previously-baked good value.
    """
    if offline:
        return
    repo = _resolve_hf_repo(entry.get("onnx_model_name"))
    if repo is None:
        return
    try:
        from huggingface_hub import HfApi
    except ImportError:
        return
    try:
        info = HfApi().model_info(repo, files_metadata=True)
    except Exception as exc:
        print(f"  ! model_info({repo!r}) failed: {type(exc).__name__}: {exc}")
        return
    family = str(entry.get("family", ""))
    advertised = set(entry.get("available_quantizations", []))
    by_quant: dict[str, int] = {}
    for sibling in info.siblings or []:
        filename = getattr(sibling, "rfilename", None) or ""
        if not _is_weight_relevant(filename, family):
            continue
        quant = _quantization_from_weight_filename(filename)
        if quant is None or quant not in advertised:
            continue
        size = _sibling_size(sibling)
        if size > 0:
            by_quant[quant] = by_quant.get(quant, 0) + size
    if not by_quant:
        return
    # Persist with deterministic ordering matching `available_quantizations`
    # so the catalog JSON diff stays minimal across re-runs.
    ordered: dict[str, int] = {}
    for quant in entry.get("available_quantizations", []):
        if quant in by_quant:
            ordered[quant] = by_quant[quant]
    entry["size_bytes_by_quantization"] = ordered


def _refresh_params(entry: dict[str, Any], param_counts: dict[str, dict[str, Any]]) -> None:
    """Pull the latest measured/published param count from the sidecar JSON.

    Leaves the existing value alone when no measurement exists for this id
    — preserves manual edits the user may have made for new entries.
    """
    model_id = str(entry["id"])
    measured = param_counts.get(model_id)
    if measured is None:
        return
    params = measured.get("params")
    if isinstance(params, int) and params > 0:
        entry["param_count"] = params


def _load_param_counts() -> dict[str, dict[str, Any]]:
    """Load ``_model_param_counts.json`` if it exists, else return empty.

    Missing file is non-fatal; the catalog keeps whatever param counts it
    already has and the user can re-run ``measure_model_params.py`` later.
    """
    if not PARAM_COUNTS_PATH.exists():
        return {}
    with PARAM_COUNTS_PATH.open("r", encoding="utf-8") as f:
        loaded = json.load(f)
    return loaded if isinstance(loaded, dict) else {}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="skip HF network calls (param_count refresh still runs)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="show the would-be diff without writing catalog.json",
    )
    args = parser.parse_args()

    with CATALOG_PATH.open("r", encoding="utf-8") as f:
        catalog = json.load(f)
    models = catalog.get("models", [])
    if not isinstance(models, list):
        print(f"!! catalog.json malformed: 'models' must be a list, got {type(models).__name__}")
        return 1

    param_counts = _load_param_counts()
    print(f"Loaded {len(models)} catalog entries (offline={args.offline}, dry_run={args.dry_run})")
    print(f"Param counts available for {len(param_counts)} models")

    for entry in models:
        if not isinstance(entry, dict):
            continue
        before_quants = list(entry.get("available_quantizations", []))
        before_params = entry.get("param_count")
        before_languages = list(entry.get("languages", []))
        before_sizes = dict(entry.get("size_bytes_by_quantization", {}))
        _refresh_quants(entry, offline=args.offline)
        _refresh_params(entry, param_counts)
        _refresh_languages(entry, offline=args.offline)
        # Size refresh happens after the quant refresh so we only ask HF
        # about quants that survived the curation filter.
        _refresh_sizes(entry, offline=args.offline)
        after_quants = entry.get("available_quantizations", [])
        after_params = entry.get("param_count")
        after_languages = entry.get("languages", [])
        after_sizes = entry.get("size_bytes_by_quantization", {})
        diffs: list[str] = []
        if before_quants != after_quants:
            diffs.append(f"quants {before_quants} -> {after_quants}")
        if before_params != after_params:
            diffs.append(f"params {before_params} -> {after_params}")
        if before_languages != after_languages:
            diffs.append(f"languages {before_languages} -> {after_languages}")
        if before_sizes != after_sizes:
            diffs.append(f"sizes {before_sizes} -> {after_sizes}")
        if diffs:
            print(f"  {entry.get('id'):40s}  {'; '.join(diffs)}")

    new_json = json.dumps(catalog, indent=2, ensure_ascii=False) + "\n"
    if args.dry_run:
        print("\n[dry-run] would write:")
        print(new_json[:500] + ("…" if len(new_json) > 500 else ""))
        return 0
    CATALOG_PATH.write_text(new_json, encoding="utf-8")
    print(f"\nWrote {CATALOG_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
