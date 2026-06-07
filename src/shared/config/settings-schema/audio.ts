import { z } from "zod";

export const audioSettingsSchema = z.object({
  inputDeviceIndex: z.number().int().nullable().default(null),
  sampleRate: z.number().int().default(16_000),
  bufferSize: z.number().int().default(512),
  // Trip threshold = 1 - sileroSensitivity (see server SileroVad.detect).
  // Default 0.7 → trip > 0.3, the reference threshold. The previous default 0.4
  // (→ trip > 0.6) silently dropped quiet/distant voices — Silero's
  // confidence on far-mic speech routinely lives in 0.3–0.6, and 0.4
  // sits on the wrong side of that band. Per-device adaptive
  // calibration (`sileroSensitivityByDeviceName` below) adjusts from
  // this baseline. A migration (store.ts SCHEMA_VERSION bump) rewrites
  // the persisted 0.4 to 0.7 for existing users.
  sileroSensitivity: z.number().min(0).max(1).default(0.7),
  sileroUseOnnx: z.boolean().default(false),
  sileroDeactivityDetection: z.boolean().default(true),
  webrtcSensitivity: z.number().int().min(0).max(3).default(3),
  postSpeechSilenceDuration: z.number().default(0.7),
  minGapBetweenRecordings: z.number().default(0),
  preRecordingBufferDuration: z.number().default(1.0),
  // Adaptive-VAD calibration map keyed by input-device name. The server
  // publishes `vad_sensitivity_adapted` after each successful recording
  // with the new Silero value; we store it under the currently-selected
  // device's name and re-apply on subsequent device switches so each mic
  // boots into adaptation with its own last-known sensitivity instead of
  // whatever the previously-active device drifted to. `.catch({})` keeps
  // older builds without this key from wiping the whole audio section.
  sileroSensitivityByDeviceName: z
    .record(z.string(), z.number().min(0).max(1))
    .default({})
    .catch({}),
  // CPAL input device index of the alternate microphone activated when the
  // laptop lid is closed (clamshell mode). When non-null, the backend
  // watches the platform lid state; on close it opens this input index,
  // and on open it restores the user's primary mic. Useful for
  // docked-laptop setups where the lid is shut and an external USB mic
  // is the only viable input. `.catch(null)` keeps an older build (no
  // key) from wiping the whole audio section on upgrade. macOS uses
  // `ioreg`; Windows uses the system lid-switch power notification.
  clamshellMicrophone: z.number().int().nullable().default(null).catch(null),
  // Consolidated mic-release policy. Replaces the original pair
  // (`always_on_microphone` + `lazy_stream_close`) — same five
  // behaviors but one picker instead of "toggle + dependent toggle":
  //
  //   - "always"    → stream stays open for the whole session.
  //                   Lowest PTT latency; OS mic-in-use indicator
  //                   stays lit while WinSTT is running.
  //   - "immediate" → release on PTT key-up (default). The OS
  //                   indicator clears decisively on every release;
  //                   each press pays a 10-50 ms reopen cost on
  //                   Windows WASAPI which the pre-roll buffer
  //                   absorbs for typical speech.
  //   - "sec30"     → stop the engine on release, then close the
  //                   stream after 30 s of inactivity. Back-to-back
  //                   presses inside the window skip the reopen
  //                   cost; idle sessions release cleanly.
  //   - "min1"      → same, after 1 minute.
  //   - "min5"      → same, after 5 minutes.
  //
  // At spawn time, `stt-process.ts` derives the three server-side
  // CLI args from this enum (`--always_on_microphone` flag,
  // `--lazy_stream_close` flag, `--lazy_close_timeout_seconds N`).
  // `.catch("immediate")` keeps older builds (corrupted persists
  // from the boolean-pair days) on the safe default that matches
  // the historical "release on release" baseline.
  microphoneRelease: z
    .enum(["always", "immediate", "sec30", "min1", "min5"])
    .default("immediate")
    .catch("immediate"),
  // Tail-of-recording capture window in ms applied to user-driven stops
  // (PTT release, toggle off). The mic keeps capturing for this many ms
  // before the pause + stop sequence runs, so trailing syllables that
  // escape just after the key-up still land in the buffer. 0 (default)
  // preserves the historical snap-stop behaviour; capped at 2000 ms so
  // a bad value can't lock the recorder. Mirrors the reference
  // `extra_recording_buffer_ms`. `.catch(0)` keeps older builds (no
  // key) from wiping the whole audio section on first read.
  extraRecordingBufferMs: z.number().int().min(0).max(2000).default(0).catch(0),
});
