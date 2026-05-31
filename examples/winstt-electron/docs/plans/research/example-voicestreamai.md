# Example study — VoiceStreamAI

A Python server + JS client for near-realtime WebSocket transcription (VAD + Whisper). Close
to WinSTT's server/client split, so its framing is relevant.

## Stealable
- **Demo video + annotated client screenshot** placed early (right after Features) — proves
  the realtime experience a static shot can't. Reinforces WinSTT improvement #4 (dictation
  GIF) for the `dictation.mdx` / realtime sections.
- **Features bullet list** that names the architecture patterns (factory/strategy, modular
  VAD/ASR swap) — signals extensibility. WinSTT's architecture pages already do this.
- **Docker run blocks** copy-paste-ready — WinSTT's dev-setup/cli use the same code-block
  pattern.

## Avoid
- Heavy CUDA/Docker setup front-and-center — appropriate for a server, but WinSTT is an
  installer-first desktop app, so keep dev/server setup below the end-user path (already
  done: Getting Started precedes Developers in the sidebar).
