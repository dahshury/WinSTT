"""Audit: for every catalog model x quantization, does onnx-asr's resolver
reference files that ACTUALLY exist in the HF repo?

This is the trust anchor for the "no silent background download" guarantee:
``model_cache.onnx_asr_would_download`` defers to onnx-asr's ``_get_model_files``,
so if that file list is wrong/incomplete for any familyxquant, the picker's
verdict can silently diverge from what a real load fetches.

Metadata-only: lists repo files (``HfApi().list_repo_files``) and may fetch the
tiny ``config.json`` to resolve a model type. NO weight downloads.

Exit code 0 when every required pattern matches a real repo file; non-zero (and
a printed MISS list) otherwise.

Run: ``uv run python scripts/audit_resolver_files.py``
"""

from __future__ import annotations

import sys
from fnmatch import fnmatch
from pathlib import PurePosixPath

from huggingface_hub import HfApi
from onnx_asr.loader import create_asr_resolver

from src.recorder.domain.model_registry import ModelCatalog
from src.recorder.infrastructure.model_cache import resolve_hf_repo


def _required_patterns(model_name: str, quant: str) -> list[str] | None:
    """The mandatory file patterns for (model, quant) — the ``_get_model_files``
    values plus the root-level variant of each ``**/`` pattern. (config.json and
    ``.onnx?data`` sidecars are conditionally present, so they're not asserted.)
    """
    try:
        resolver = create_asr_resolver(model=model_name)
        files = list(resolver.model_type._get_model_files(quant or None).values())
    except Exception as exc:
        print(f"    ! resolver error: {type(exc).__name__}: {exc}")
        return None
    return [*files, *(f.removeprefix("**/") for f in files if f.startswith("**/"))]


def _matches(pattern: str, repo_files: list[str]) -> bool:
    # A ``**/x`` pattern matches a nested file; its stripped ``x`` variant (added
    # by _required_patterns) covers root-level. fnmatch is HF's allow_patterns
    # matcher. Also accept an ``.ort`` twin (onnx-asr's find() fallback).
    alts = [pattern]
    if pattern.endswith(".onnx"):
        alts.append(str(PurePosixPath(pattern).with_suffix(".ort")))
    return any(fnmatch(f, alt) for f in repo_files for alt in alts)


def main() -> int:
    catalog = ModelCatalog()
    api = HfApi()
    repo_files_cache: dict[str, list[str]] = {}
    misses: list[str] = []
    audited = 0

    for model in catalog.list_all():
        if model.local_path or not model.onnx_model_name:
            continue  # custom local bundles / cloud — no HF resolution
        repo = resolve_hf_repo(model.onnx_model_name)
        if repo is None:
            continue
        if repo not in repo_files_cache:
            try:
                repo_files_cache[repo] = api.list_repo_files(repo)
            except Exception as exc:
                print(f"[SKIP] {model.id}: list_repo_files failed: {type(exc).__name__}: {exc}")
                repo_files_cache[repo] = []
        repo_files = repo_files_cache[repo]
        if not repo_files:
            continue

        for quant in model.available_quantizations:
            audited += 1
            label = f"{model.id} [{quant or 'default'}]"
            patterns = _required_patterns(model.onnx_model_name, quant)
            if patterns is None:
                misses.append(f"{label}: resolver could not produce a file list")
                print(f"[MISS] {label}: no resolver file list")
                continue
            unmatched = [p for p in patterns if not _matches(p, repo_files)]
            # A ``**/x`` and its stripped ``x`` are alternatives for the same
            # logical file — only flag when BOTH variants are unmatched.
            logical_miss = [
                p
                for p in unmatched
                if not p.startswith("**/") and (("**/" + p) not in patterns or ("**/" + p) in unmatched)
            ]
            if logical_miss:
                misses.append(f"{label}: {logical_miss}")
                print(f"[MISS] {label}: required files not in repo: {logical_miss}")
            else:
                print(f"[ OK ] {label}")

    print(f"\nAudited {audited} modelxquant combinations across {len(repo_files_cache)} repos.")
    if misses:
        print(f"\n{len(misses)} PROBLEM(S):")
        for m in misses:
            print(f"  - {m}")
        return 1
    print("ALL GOOD — every required file resolves to a real repo file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
