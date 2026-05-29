# Example study — sherpa-onnx

A low-level, cross-platform ONNX speech toolkit (ASR/TTS/diarization/VAD/KWS). Not a
product like WinSTT, but its README is a masterclass in **capability/support matrices**.

## Stealable
- **Capability matrix** — a grid of features × ✔️ ("Speech recognition | TTS | Source
  separation", "Speaker ID | Diarization | Verification", …). WinSTT's `comparison.mdx`
  already uses a feature table; the at-a-glance ✔️ matrix is the same idea.
- **Platform / language support matrices** — architecture × OS, and a numbered list of
  supported languages/bindings. WinSTT could use a compact "platform support" mini-table on
  `install.mdx` (Windows ✔, Linux/macOS roadmap).
- Leads with WHAT it can do before HOW — matches WinSTT's "what before how" rule.

## Avoid
- Wall-of-matrices with no prose/visuals — fine for a toolkit, too dry for a product. WinSTT
  is rightly more screenshot- and prose-driven.
