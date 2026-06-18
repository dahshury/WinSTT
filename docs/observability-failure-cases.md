# Observability Failure Cases

WinSTT is local-first, so observability stays local by default. Operational
issues are captured in three places:

- User surfaces: existing status rows, toasts, progress states, and the About >
  Diagnostics recent-issues list.
- App logs: structured `[observability]` log entries with area, operation, kind,
  model/provider/request context, duration, and remediation when known.
- Diagnostic bundle: `diag_save_bundle` includes `observability-timeline.json`
  alongside logs and system info.

## Startup and Runtime

1. Tauri application build failure.
2. Main window creation failure.
3. Core startup initialization failure.
4. Onboarding window creation failure.
5. Splash/main readiness handoff stalls.
6. Renderer startup probes exceed the readiness timeout.
7. Webview JavaScript error before UI renders.
8. Webview blank-window crash in a secondary window.
9. Panic in a Rust thread.
10. VAD preload failure during startup.
11. Log directory or portable app data directory access failure.
12. Settings load failure during first paint.
13. Runtime info probe stalls during first paint.
14. Audio device enumeration stalls during first paint.
15. GPU info probe stalls or fails.
16. Tray/window lifecycle command failure.
17. Main process cannot create a worker thread.
18. Poisoned mutex/state after an unexpected panic.
19. Background prewarm scheduling failure.
20. Startup proceeds but a subsystem stays degraded or inert.

## STT and Transcription

1. Local STT model load fails.
2. Local STT model load panics.
3. Model warmup fails.
4. Warmup detects degenerate output.
5. CPU fallback reload after degenerate output fails.
6. Model cannot be prepared for a transcription request.
7. Engine state is empty after the load wait.
8. Engine mutex becomes empty before decode.
9. STT engine decode fails.
10. STT engine decode panics.
11. STT decode completes but is slow.
12. Selected model is too large for RAM or VRAM.
13. Accelerator or DirectML allocation fails.
14. Model cache is missing or incomplete.
15. Model file is corrupt or fails a cache self-check.
16. Model quantization cannot be resolved.
17. STT model download plan cannot be built.
18. STT model file download fails.
19. Cloud STT provider request fails.
20. Cloud STT is selected while the network, key, quota, or provider is down.

## TTS and Playback

1. TTS request starts while TTS is disabled.
2. Local TTS runtime setup fails.
3. Local TTS model assets cannot be prepared.
4. Local voice download fails.
5. TTS synthesis lock is poisoned.
6. Local synthesis fails.
7. Cloud synthesis fails.
8. OpenRouter TTS preview fails.
9. Cloud preview clip fetch fails.
10. TTS model predownload fails.
11. TTS model download is interrupted by network loss.
12. TTS model download hits disk-full or permission errors.
13. TTS voice archive is corrupt or incomplete.
14. Selected voice is unavailable for the selected model.
15. Provider API key is missing.
16. Provider API key is rejected.
17. Provider rate limit is hit.
18. Provider times out.
19. Playback output device is missing or unreachable.
20. Browser audio sink switch rejects and playback falls back.

## LLM Post-Processing

1. Ollama dictation post-processing fails and original text is kept.
2. Ollama transform fails and original text is kept.
3. OpenRouter primary LLM request fails and fallback is attempted.
4. OpenRouter fallback fails and original text is kept.
5. OpenRouter request fails with no usable fallback.
6. OpenRouter request times out.
7. OpenRouter request is cancelled by user action.
8. Cloud provider reports auth failure.
9. Cloud provider reports missing key.
10. Cloud provider reports rate limiting.
11. Cloud provider is unreachable or DNS fails.
12. Cloud provider returns malformed data.
13. Ollama catalog refresh cannot reach the daemon.
14. Ollama catalog refresh returns a daemon error.
15. OpenRouter catalog refresh fails.
16. OpenRouter STT catalog refresh fails.
17. OpenRouter TTS catalog refresh fails.
18. Ollama is not installed when start is requested.
19. Ollama daemon starts but does not bind within the timeout.
20. Ollama model pull or delete fails.

## File Transcription, Wake Word, and Devices

1. Dropped file has no decodable audio.
2. Audio track has no codec parameters.
3. Packet read fails.
4. Decoder fails on a hard decode error.
5. Sample rate changes mid-file.
6. Decoded audio exceeds the in-memory safety limit.
7. File transcription STT request fails.
8. File transcription row is cancelled mid-flight.
9. Copying a completed file transcript to clipboard fails.
10. Wake-word runtime asset download fails.
11. Wake-word download worker fails to start.
12. Wake-word runtime archive hash verification fails.
13. Wake-word runtime archive is incomplete.
14. Wake-word phrase tokenization fails.
15. Legacy Porcupine detector build fails.
16. Sherpa KWS detector build fails.
17. Wake-word runtime files are missing and the detector stays inert.
18. Microphone device disappears while listening.
19. Output device disappears before playback.
20. Device enumeration returns stale or conflicting browser/native data.

## Implementation Notes

- `src-tauri/src/winstt/observability.rs` owns the bounded in-memory timeline and
  structured log emission.
- `diag_observability_timeline` exposes recent issues to the renderer.
- `diag_save_bundle` writes `observability-timeline.json` into the support zip.
- The About diagnostics panel reads the timeline directly through generated
  tauri-specta bindings.
- Issue classification normalizes common failures into kinds such as
  `out_of_memory`, `timeout`, `network`, `auth`, `key_missing`, `rate_limited`,
  `disk_full`, `permission_denied`, `model_corrupt`, `not_found`, `panic`, and
  `cancelled`.
