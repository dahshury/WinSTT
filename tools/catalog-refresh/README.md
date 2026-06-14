# Model catalog refresh tooling

`refresh_catalog.py` rebuilds the STT model catalog from HuggingFace + `onnx-asr`:
it resolves canonical repos, derives `available_quantizations` from the ONNX
filenames each repo actually ships, refreshes `param_count` (via
`measure_model_params.py` → `_model_param_counts.json`) and `languages` from each
model card, and preserves the editorial fields.

This is **reference tooling**, not part of the build. The live runtime catalog is
hand-maintained deterministic data in `src-tauri/src/winstt/catalog.rs`; use this
script when bulk-refreshing model metadata from upstream before updating the Rust
catalog.

## Requirements

It needs a Python environment with `onnx-asr` (and its deps) installed — the same
toolchain `onnx-asr` itself uses to resolve repos. There is no Python in the app
runtime, so set up a throwaway venv to run it:

```
python -m venv .venv && .venv/Scripts/activate
pip install onnx-asr huggingface_hub
python tools/catalog-refresh/refresh_catalog.py --dry-run
```

Flags: `--offline` (skip HF), `--dry-run` (don't write).
