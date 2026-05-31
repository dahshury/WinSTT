# Example study — kokoro-onnx

The ONNX wrapper for the Kokoro TTS model WinSTT bundles. A clean, badge-forward library
README.

## Stealable
- **Badge row** — Python version, PyPI release, GitHub release, license, **stars**,
  **downloads**, ONNX-runtime version, CPU/GPU supported. WinSTT's README now carries a
  similar row; the landing could add stars/downloads/version badges (improvement #5).
- **Embedded demo video** right under the title (before any prose) — "show, then tell".
  WinSTT reserves a slot for a dictation GIF/video (improvement #4).
- **`<details>` collapsibles** for long setup instructions — keeps the README scannable.
  Useful for WinSTT's manual-install / dev-setup pages.
- **Tiny "Features" bullet list** with concrete numbers ("~300MB, quantized ~80MB",
  "near real-time on M1"). Numbers over adjectives — matches WinSTT's style guide.

## Avoid
- Library-level framing (pip install, API) — WinSTT is an end-user app, so lead with the
  product experience, not the package.
