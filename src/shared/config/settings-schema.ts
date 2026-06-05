import { z } from "zod";
import {
  DeviceTypeSchema,
  TranscriberBackendSchema,
} from "@/shared/api/schema.zod";

const modelUnloadTimeoutSchema = z
  .enum(["immediately", "never", "min2", "min5", "min10", "min15", "hour1"])
  .default("min5")
  .catch("min5");

export const modelSettingsSchema = z.object({
  // Bundled offline base model — see `project_offline_base_and_tts_pack`
  // memory. tiny-q4 is vendored into the installer so first-run users
  // transcribe with zero network traffic. The historical "large-v2"
  // default predates the offline-base seeding and resolved to a Whisper
  // catalog id that the picker no longer surfaces; falling back to it
  // on a partial-save decode produced the "large v2 in the main window
  // but vosk-russian in the picker" desync (different fallbacks across
  // surfaces). "tiny" exists in every catalog flavor and matches the
  // CLI default the reference spawn passes (`--model tiny`).
  model: z.string().default("tiny"),
  realtimeModel: z.string().default("tiny"),
  language: z.string().default("en"),
  device: DeviceTypeSchema.default("auto"),
  backend: TranscriberBackendSchema.default("faster_whisper"),
  // "auto" = the RAM/VRAM-aware recommended precision (re-resolved by the
  // backend's ``fit_aware_auto_quant`` for the user's live hardware). ""
  // is no longer "auto" — it now means EXPLICIT fp32 (the full-precision
  // base export), a normal selectable badge. Concrete tiers (int8/fp16/…)
  // pass through verbatim.
  onnxQuantization: z.string().default("auto"),
  initialPrompt: z.string().default(""),
  initialPromptRealtime: z.string().default(""),
  // Whisper-native task=translate. When true and the active model is a
  // multilingual Whisper variant, audio is transcribed AND translated to
  // English in a single decode (no extra latency, no LLM round-trip).
  // Ignored when the model lacks translate support (e.g. *.en variants,
  // non-Whisper families like Moonshine). `.catch(false)` keeps older
  // builds from wiping the whole model section on a corrupt persisted value.
  translateToEnglish: z.boolean().default(false).catch(false),
});

const globalSettingsSchema = z.object({
  // Idle-timeout shared by local STT, realtime preview, local TTS, and
  // Ollama keep-alive. Default "min5".
  modelUnloadTimeout: modelUnloadTimeoutSchema,
});

export const qualitySettingsSchema = z.object({
  useMainModelForRealtime: z.boolean().default(false),
  realtimeProcessingPause: z.number().default(0.02),
  initRealtimeAfterSeconds: z.number().default(0.2),
  earlyTranscriptionOnSilence: z.number().default(0.2),
  ensureSentenceStartingUppercase: z.boolean().default(true),
  ensureSentenceEndsWithPeriod: z.boolean().default(true),
  // ON by default: the DistilBERT sentence-completion classifier extends
  // the silence pause when the utterance is semantically incomplete, which
  // is the purpose-built defence against finalizing mid-thought. With it
  // off, the crude punctuation heuristic (unknownSentenceDetectionPause)
  // cut speakers off during natural pauses.
  smartEndpoint: z.boolean().default(true),
  // Pause multiplier: pause = (model + whisper) * smartEndpointSpeed.
  // HIGHER = longer wait = more patient. Default 2.0 matches the
  // RealtimeSTT reference (its binary-classified smart-endpoint example
  // ships 2.0); the old 1.5 committed ~25% sooner everywhere and read
  // as "pastes too eagerly" in toggle dictation.
  smartEndpointSpeed: z.number().min(0.5).max(3.0).default(2.0),
  // Sentence-pause durations driving the toggle-mode silence-timing heuristic
  // (the fallback when Smart Endpoint is off). Defaults match the server's
  // CLI argument defaults. unknownSentenceDetectionPause governs normal
  // mid-sentence speech; 0.7s cut off natural breath/think pauses, so the
  // default is 1.3s.
  endOfSentenceDetectionPause: z.number().min(0.1).max(5.0).default(0.45),
  midSentenceDetectionPause: z.number().min(0.1).max(10.0).default(2.0),
  unknownSentenceDetectionPause: z.number().min(0.1).max(5.0).default(1.3),
});

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

// One entry in the recording-sound library. The default sound is implicit
// (never persisted); every entry here is a user-uploaded clip stored under
// `userData/sounds/`. `path` is the absolute path on disk; `name` is the
// display label (renamable independently of the on-disk filename).
const soundLibraryEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
});
export type SoundLibraryEntry = z.output<typeof soundLibraryEntrySchema>;

export const generalSettingsSchema = z.object({
  autoStart: z.boolean().default(false),
  minimizeToTray: z.boolean().default(true),
  startMinimized: z.boolean().default(false),
  // Percent reduction applied to system playback volume while dictating.
  // 0 = off (volume untouched), 100 = full mute; intermediate values duck
  // to (100 - value)% of the previous level. The UI constrains this to
  // multiples of 20; `.catch(0)` covers older builds that persisted the
  // legacy boolean (migrated in electron/lib/store.ts).
  systemAudioReductionWhileDictating: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(60)
    .catch(60),
  recordingSound: z.boolean().default(true),
  // Active recording sound. Empty string = built-in default. Otherwise the
  // absolute path of an entry in `recordingSoundLibrary`.
  recordingSoundPath: z.string().default(""),
  // User-uploaded clips, copied into `userData/sounds/` by the main process
  // on add so the library survives the user moving/renaming the source file.
  // `.catch([])` keeps older builds (no key) from wiping the whole general
  // section on first read.
  recordingSoundLibrary: z.array(soundLibraryEntrySchema).default([]).catch([]),
  fileTranscriptionFormat: z.enum(["txt", "srt"]).default("txt"),
  fileTranscriptionSaveLocation: z.enum(["auto", "ask"]).default("auto"),
  recordingMode: z.enum(["ptt", "toggle", "listen", "wakeword"]).default("ptt"),
  // True manual toggle: in `toggle` mode, recording runs continuously from
  // first hotkey press to second press — silence-VAD stop and silence-timing
  // punctuation tuning are both disabled. Ignored in other modes. Off by
  // default so the documented "stops on silence, restarts on speech"
  // behaviour stays the baseline for users who haven't opted in.
  manualToggleStop: z.boolean().default(false),
  // Global shortcut that re-pastes the most recent dictation transcription
  // into the focused window on demand. Registered as an EXCLUSIVE system-
  // wide shortcut (the reference globalShortcut) — it is swallowed app-wide so
  // pressing it ONLY triggers our re-paste and never also fires the focused
  // app's native binding (e.g. paste-without-formatting). Stored in the same
  // uiohook-style accelerator format the HotkeyRecorder produces; the main
  // process converts it to the reference accelerator at registration time.
  // Must be non-empty: an empty string from corrupt settings would leave
  // the feature silently disabled; instead `.catch()` rehydrates to the
  // canonical default so the binding is always present.
  repasteHotkey: z
    .string()
    .min(1)
    .default("LCtrl+LShift+V")
    .catch("LCtrl+LShift+V"),
  loopbackDeviceIndex: z.number().int().nullable().default(null),
  // Wake phrase used when recordingMode is "wakeword". Preset phrases and
  // arbitrary custom phrases are tokenized with the downloaded sherpa KWS
  // model's BPE files, so the UI must preserve unknown non-empty values.
  // Defaults to "alexa" so first switch into wakeword mode has a known phrase.
  wakeWord: z.string().default("alexa"),
  // User-saved custom wake phrases shown in the wake-word combobox. The active
  // phrase still lives in `wakeWord`; this list is only the saved/manageable
  // custom catalog for add/delete/select UX.
  customWakeWords: z.array(z.string()).default([]).catch([]),
  // Detection sensitivity passed to the sherpa KWS detector. Lower = stricter
  // (fewer false positives, may miss soft pronunciations); higher = more
  // permissive. 0.6 is a sensible compromise for most voices.
  wakeWordSensitivity: z.number().min(0).max(1).default(0.6),
  // Seconds the wake-word gate stays armed after a detection before
  // auto-clearing. If the user says the wake word but doesn't follow up
  // within this window, the engine returns to listening for the trigger
  // again — protects against accidental long-tail recordings triggered by
  // stray noise minutes after the user actually said the wake word.
  wakeWordTimeout: z.number().min(1).max(30).default(5),
  showRecordingOverlay: z.boolean().default(true),
  // Layout of the recording overlay.
  // `floating-bottom` keeps the historical two-piece pill near the bottom
  // of the primary display; `dynamic-island` docks a morphing capsule flush
  // against the top-center of the primary display, switching size presets
  // in OverlayPage as content changes. `.catch` keeps an older persisted
  // value (or a missing key on first read after upgrade) from wiping the
  // whole `general` section.
  overlayMode: z
    .enum(["floating-bottom", "dynamic-island"])
    .default("floating-bottom")
    .catch("floating-bottom"),
  // Coarse-grained screen-edge gate, modeled after a screen-edge
  // `OverlayPosition` enum. Distinct from `overlayMode`
  // (which picks the visual layout style): this controls WHETHER the pill
  // is allowed to appear and on which screen edge.
  //   - `"auto"` (default): platform-derived in `resolveOverlayPosition`.
  //     Linux → effectively `"none"` because some compositors break paste
  //     pipelines when an always-on-top window appears mid-keystroke.
  //     macOS / Windows → effectively `"bottom"`.
  //   - `"none"`: never show the pill, regardless of platform.
  //   - `"top"` / `"bottom"`: explicit screen edge.
  // `.catch` keeps an older persisted value (or missing key on upgrade)
  // from wiping the whole `general` section.
  overlayPosition: z
    .enum(["auto", "none", "top", "bottom"])
    .default("auto")
    .catch("auto"),
  // `.catch` covers older builds that persisted an integer pixel value;
  // without it an integer here fails the whole settings parse and the codec
  // falls back to ALL defaults, wiping unrelated settings on upgrade.
  visualizerSize: z
    .enum(["xs", "sm", "md", "lg", "xl"])
    .default("xs")
    .catch("xs"),
  // Single multi-choice replaces the old `showLiveTranscription` (pill) and
  // `showInAppLiveTranscription` (main window) booleans. `.catch` keeps an
  // older persisted value from wiping the whole `general` section on upgrade.
  liveTranscriptionDisplay: z
    .enum(["none", "in-app", "in-pill", "both"])
    .default("both")
    .catch("both"),
  visualizerType: z
    .enum(["bar", "grid", "radial", "wave", "aura"])
    .default("bar"),
  // `.catch(9)` covers stale persisted values from an earlier slider bug that
  // emitted 22 (off the zero-anchored snap grid). Without it, a single
  // out-of-range integer fails the whole `general` parse in
  // `decodeSettingsPayload`, and other windows fall back to ALL defaults —
  // which then broadcasts back and silently resets unrelated settings.
  visualizerBarCount: z.number().int().min(3).max(21).default(9).catch(9),
  // Per-shape visualizer customization. Each knob mirrors the bar-count
  // pattern above: a defaulted, `.catch`-guarded scalar that the renderer
  // forwards into the matching component prop / shader uniform (see
  // `resolveVisualizerConfig` in features/audio-visualizer). Defaults
  // reproduce the previous hardcoded look exactly. `.catch` keeps a stale
  // out-of-range persisted value from failing the whole `general` parse —
  // which would otherwise fall back to ALL defaults and silently wipe
  // unrelated settings across windows on upgrade.
  // — Radial —
  visualizerRadialDotCount: z
    .number()
    .int()
    .min(6)
    .max(48)
    .default(24)
    .catch(24),
  // Ring radius as a percentage of the visualizer's half-height (size-relative
  // so it stays sensible across the xs–xl overlay presets). ~57 % reproduces
  // the previous size-derived radius.
  visualizerRadialRadius: z
    .number()
    .int()
    .min(20)
    .max(90)
    .default(57)
    .catch(57),
  // — Grid —
  visualizerGridRows: z.number().int().min(3).max(8).default(5).catch(5),
  visualizerGridColumns: z.number().int().min(3).max(8).default(5).catch(5),
  // Idle-sweep speed (1 = slow … 10 = fast); mapped to the animation interval
  // via `gridSpeedToInterval` (interval = round(600 / speed)). 6 ≈ the previous
  // 100 ms tick.
  visualizerGridSpeed: z.number().int().min(1).max(10).default(6).catch(6),
  // — Wave (WebGL) —
  visualizerWaveLineWidth: z.number().int().min(1).max(6).default(2).catch(2),
  // Edge softness, 0–100 % → uSmoothing 0.0–1.0 (50 → 0.5, the previous value).
  visualizerWaveSmoothing: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(50)
    .catch(50),
  // Rainbow hue-shift toward the wave edges, 0–100 % → uColorShift 0.0–1.0
  // (5 → 0.05, the previous value; the shader treats < 1 % as off).
  visualizerWaveColorShift: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(5)
    .catch(5),
  // — Aura (WebGL) —
  visualizerAuraShape: z
    .enum(["circle", "line"])
    .default("circle")
    .catch("circle"),
  // Field blur, 0–100 % → uBlur 0.0–1.0 (20 → 0.2, the previous value).
  visualizerAuraBlur: z.number().int().min(0).max(100).default(20).catch(20),
  // Additive bloom (dark theme only), 0–100 % → uBloom 0.0–1.0 (0 → off).
  visualizerAuraBloom: z.number().int().min(0).max(100).default(0).catch(0),
  // Rainbow hue-shift across the aura, 0–100 % → uColorShift 0.0–1.0 (5 → 0.05).
  visualizerAuraColorShift: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(5)
    .catch(5),
  contextAwareness: z.boolean().default(false),
  /**
   * User-managed deny-list for context capture. Each entry is either
   * an executable basename (`"1password.exe"`) or a URL host suffix
   * (`"bankofamerica.com"` — any subdomain matches). When the active
   * app or URL matches an entry, the captured snapshot is stripped of
   * focused-text / axHtml / URL fields before reaching the LLM. The
   * window title still flows through as harmless metadata. Seed list
   * covers common password managers — anyone hitting "remove" in the
   * UI gets that change persisted; the seed only applies on first run.
   */
  contextDenyList: z
    .array(z.string())
    .default([
      "1password.exe",
      "bitwarden.exe",
      "keepass.exe",
      "keepassxc.exe",
      "dashlane.exe",
      "lastpass.exe",
    ])
    .catch([
      "1password.exe",
      "bitwarden.exe",
      "keepass.exe",
      "keepassxc.exe",
      "dashlane.exe",
      "lastpass.exe",
    ]),
  // Speaker diarization — per-utterance, with session-wide identity tracking.
  // Toggle-mode only in the UI (long-form dictation is where multi-speaker
  // conversations actually happen); the server still runs the same pipeline
  // regardless of recording mode. First-run downloads ~32 MB of ONNX models.
  speakerDiarization: z.boolean().default(false),
  // Opt-out toggle for Sentry crash/error reporting. Defaults to `true` —
  // installers ship with reporting on so we collect the early-adopter crash
  // data we can't reproduce locally. The Tauri port must not ask the user to
  // restart after toggling this setting.
  sendCrashReports: z.boolean().default(true),
  // Opt-in toggle for pre-release (alpha/beta) auto-updates. Defaults to
  // `false` so a future stable release stays on stable for everyone except
  // users who explicitly want early access. The main process OR-s this with
  // "current build is a pre-release" so alpha installs keep updating to
  // newer alphas regardless of the toggle — the user-facing knob only
  // changes behavior once we cut the first stable.
  receivePrereleaseUpdates: z.boolean().default(false),
  // First-run onboarding gate. `false` triggers the onboarding wizard window
  // (one-time wizard that picks local vs cloud STT, tests the mic, optionally
  // collects cloud keys, and offers Ollama setup). `.catch(false)` means a
  // corrupt persisted value re-shows the wizard rather than skipping it —
  // re-running setup is cheap; silently skipping a broken first install isn't.
  onboarded: z.boolean().default(false).catch(false),
  // Epoch-ms when the user finished (or skipped) the wizard. Null until then.
  // Used for telemetry / debugging only — the gate keys off `onboarded`.
  onboardedAt: z.number().nullable().default(null).catch(null),
  // Which STT track the wizard picked: local Whisper or a cloud provider.
  // Empty until the wizard runs; settings UI doesn't read it directly (it
  // reads the active model from `model.model`), but the wizard persists it
  // so we can answer "did this user start on cloud?" in support tickets.
  onboardedTrack: z.enum(["", "local", "cloud"]).default("").catch(""),
  // Output audio device used for TTS playback and recording-mode chimes.
  // Identified by `MediaDeviceInfo.deviceId` (renderer-side); the empty
  // string falls back to the system default. Null is normalized to "" by
  // `.catch` so consumers can treat both interchangeably. Web Audio's
  // `setSinkId()` powers the routing — both surfaces (recording sounds via
  // HTMLAudioElement, TTS via AudioContext) accept the deviceId verbatim.
  outputDeviceId: z.string().default("").catch(""),
  // Auto-press a "submit" key after each dictation paste lands. Off by
  // default to preserve historical behaviour (paste, leave cursor where
  // the user can review). When on, `autoSubmitKey` chooses which combo
  // to inject — Enter for chat boxes, Ctrl+Enter for IDE prompts.
  autoSubmit: z.boolean().default(false).catch(false),
  autoSubmitKey: z
    .enum(["enter", "ctrl_enter"])
    .default("enter")
    .catch("enter"),
  // Gate the auto-paste behind an editable preview pill the user confirms
  // before pasting (the magic button re-runs LLM post-processing on demand).
  // Only effective when the recording pill is shown — the preview IS the pill.
  previewBeforePasting: z.boolean().default(false).catch(false),
  // Stream generated realtime text into the focused app while dictation is still
  // active. Only effective when the loaded main STT model is a native-streaming
  // realtime model; mutually exclusive with preview-before-pasting.
  wordByWordPasting: z.boolean().default(false).catch(false),
  // Cap on the number of transcription history entries persisted to disk.
  // Larger histories slow the settings panel (rendering + load), so the
  // upper bound is 10000; lower bound 10 keeps the UI useful. The main
  // process trims on each insert and on settings change.
  historyMaxEntries: z
    .number()
    .int()
    .min(10)
    .max(10_000)
    .default(1000)
    .catch(1000),
  // Auto-delete saved WAV recordings older than this policy. "never"
  // preserves everything; "cap" deletes oldest recordings beyond
  // historyMaxEntries; days3/weeks2/months3 are absolute age cutoffs.
  // Cleanup runs once at app startup and again whenever the policy changes.
  recordingRetention: z
    .enum(["never", "cap", "days3", "weeks2", "months3"])
    .default("cap")
    .catch("cap"),
  // Threshold for the server-side deterministic fuzzy corrector that
  // runs BEFORE the LLM modifier pipeline. Lower = stricter (fewer
  // false positives, more genuine near-misses left for the LLM to fix).
  // 0.18 is the reference default. `.catch(0.18)`
  // keeps an older persisted value (or a corrupt entry) from wiping the
  // whole `general` section on upgrade.
  wordCorrectionThreshold: z.number().min(0).max(1).default(0.18).catch(0.18),
  // Locale-aware filler-word stripping + 3+ stutter collapse, modeled
  // on a `filter_transcription_output` pass. When `true` (default)
  // the server post-processor consults `customFillerWords` first; an
  // empty list falls back to a per-language table (e.g. English
  // "uh"/"um"/"hmm" — see `filler_filter.FILLERS_BY_LANG`). Tokens
  // that are real words in other locales (Portuguese "um", Spanish
  // "ha") are deliberately omitted from those tables.
  filterFillers: z.boolean().default(true).catch(true),
  // Optional per-user override for the language disfluency table.
  // Empty (default) → use the language table. Non-empty → use these
  // instead. To disable filler removal without changing the master
  // toggle, set this AND flip `filterFillers` off.
  customFillerWords: z.array(z.string()).default([]).catch([]),
});

export const hotkeySettingsSchema = z.object({
  // `.catch("LCtrl+LMeta")` is the rescue path: if settings.json on disk
  // ever sneaks an empty string in (legacy data, hand-edit, sync conflict),
  // `.min(1)` would throw and `decodeSettingsPayload` would wipe the whole
  // `hotkey` section. Catch rehydrates to the documented default so the
  // PTT binding is always present and never empty.
  pushToTalkKey: z.string().min(1).default("LCtrl+LMeta").catch("LCtrl+LMeta"),
});

// Dictionary entries are dual-purpose, matching Wispr Flow's two-mode model:
//
//  - VOCAB words (`replacement` absent) — names, jargon, proper nouns the
//    model should bias TOWARD. Folded into the LLM system prompt via
//    withVocabPrefix and (when LLM is off) fuzzy-matched by the algorithmic
//    post-processor in text-processing.ts.
//
//  - REPLACEMENT PAIRS (`replacement` present) — `term` is a common
//    mis-transcription that should always become `replacement`. Applied as a
//    case-insensitive whole-word string replace AFTER the LLM cleanup pass,
//    so the rule fires deterministically regardless of what the model did.
//    The LLM is also told about the pair in its prompt so it can apply the
//    correction with context awareness; the post-pass is the safety net.
export const dictionaryEntrySchema = z.object({
  id: z.string().min(1),
  term: z.string().min(1, "Required"),
  replacement: z.string().optional(),
});
export type DictionaryEntry = z.infer<typeof dictionaryEntrySchema>;

export const addDictionaryEntrySchema = z.object({
  term: z.string().trim().min(1, "Required"),
  replacement: z.string().trim().optional(),
});

export const snippetEntrySchema = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1, "Required"),
  expansion: z.string().min(1, "Required"),
});

export const addSnippetEntrySchema = z.object({
  trigger: z.string().trim().min(1, "Required"),
  expansion: z.string().trim().min(1, "Required"),
});

const presetKeySchema = z.enum([
  "neutral",
  "formal",
  "friendly",
  "technical",
  "concise",
  "summarize",
  "reorder",
  "restructure",
  "rewordForClarity",
  "translate",
]);

const presetLevelSchema = z.enum(["light", "medium", "high"]);

const KEYS_WITH_LEVELS = new Set(["summarize", "concise"]);
const TONE_KEYS = new Set(["neutral", "formal", "friendly", "technical"]);

const presetEntrySchema = z
  .object({
    key: presetKeySchema,
    level: presetLevelSchema.optional(),
    // English name of the target language; only meaningful for `translate`.
    // Mirrors how `level` parameterizes summarize/concise.
    targetLang: z.string().optional(),
  })
  .refine(
    (entry) => entry.level === undefined || KEYS_WITH_LEVELS.has(entry.key),
    {
      message: "level is only allowed for summarize or concise",
      path: ["level"],
    },
  )
  .refine(
    (entry) => entry.targetLang === undefined || entry.key === "translate",
    {
      message: "targetLang is only allowed for the translate preset",
      path: ["targetLang"],
    },
  );

const presetsSchema = z
  .array(presetEntrySchema)
  .default([{ key: "neutral" }])
  .refine(
    (entries) => {
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.key)) {
          return false;
        }
        seen.add(entry.key);
      }
      return true;
    },
    { message: "duplicate preset keys are not allowed" },
  )
  .refine(
    (entries) => {
      const toneCount = entries.filter((e) => TONE_KEYS.has(e.key)).length;
      return toneCount <= 1;
    },
    {
      message:
        "only one tone preset (neutral/formal/friendly/technical) may be active",
    },
  );

// User-authored cleanup modifiers layered on top of the built-in tone /
// independent presets. Unlike `presetsSchema` (which holds only *active*
// built-in keys), this array persists the full definition even while
// `enabled` is false so the name/prompt the user wrote survives a toggle.
// `level` is always allowed here — for a custom modifier the Low/Medium/High
// switcher tunes intensity of the single authored prompt rather than
// selecting between distinct texts (see `CUSTOM_LEVEL_HINT`).
const customModifierSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  prompt: z.string().default(""),
  enabled: z.boolean().default(false),
  // When false the prompt is applied verbatim; when true the Low/Medium/High
  // switcher appears on the row and `level` tunes the intensity hint.
  levelsEnabled: z.boolean().default(false),
  level: presetLevelSchema.optional(),
});

// Per-feature provider config. Dictation and transforms each pick their own
// provider (Ollama, OpenRouter, or Apple Intelligence) and own model
// selection independently — so e.g. dictation can run a fast local Ollama
// while transforms hits an OpenRouter frontier model. Infra-level fields
// (Ollama endpoint URL, OpenRouter API key) stay shared on
// `llmSettingsSchema` — one Ollama instance, one OpenRouter account.
// `apple-intelligence` is a no-config provider that runs Apple's on-device
// FoundationModels through a bundled Swift CLI; it has no endpoint/key/
// model field of its own (the platform decides). The UI hides this option
// on non-darwin / non-arm64 hosts; settings will round-trip the value if
// it was persisted on a different machine.
const llmFeatureBaseShape = {
  provider: z
    .enum(["ollama", "openrouter", "apple-intelligence"])
    .default("ollama"),
  model: z.string().default(""),
  openrouterModel: z.string().default(""),
  openrouterFallbackModel: z.string().default(""),
  // OpenRouter request-tuning parameters. Only sent on the wire when the
  // selected model's `supported_parameters` advertises support, but the
  // defaults persist so the picker's ReasoningControls renders consistent
  // initial values regardless of the previously-selected model.
  reasoningEffort: z.enum(["low", "medium", "high"]).default("medium"),
  verbosity: z.enum(["low", "medium", "high"]).default("medium"),
  maxOutputTokens: z.number().int().min(1).nullable().default(null),
  // Thinking budget for Ollama models that advertise the `thinking`
  // capability via `/api/show`. Mirrors Ollama's `ThinkValue`:
  //   - `"off"` → `think: false` (force-disable for thinking models)
  //   - `"low" | "medium" | "high"` → passed verbatim as the request field
  // Non-thinking models always send `think: false` regardless of this
  // setting; the chat-body builder gates on the capability check.
  thinkingEffort: z.enum(["off", "low", "medium", "high"]).default("medium"),
};

const llmDictationSchema = z.object({
  enabled: z.boolean().default(false),
  ...llmFeatureBaseShape,
  presets: presetsSchema,
  // Empty by default; rows are appended from the Modifiers UI. Folded into
  // the runtime presets array at processing time via
  // `mergePresetsWithCustomModifiers` — never persisted into `presets`.
  customModifiers: z.array(customModifierSchema).default([]),
});

// Single user-configurable text transform. Mirrors the OpenAPI `Transform`
// schema (see `spec/openapi.yaml`). Built-in entries flag `builtin: true`
// so the UI can show a Reset action instead of Delete.
const transformSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  prompt: z.string().default(""),
  hotkey: z.string().default(""),
  builtin: z.boolean().default(false),
});

const llmTransformsSchema = z.object({
  enabled: z.boolean().default(false),
  ...llmFeatureBaseShape,
  // Same composition shape as dictation: ordered preset list + custom modifiers.
  // At runtime, mergePresetsWithCustomModifiers folds them into a single prompt
  // applied to the currently-selected text.
  presets: presetsSchema,
  customModifiers: z.array(customModifierSchema).default([]),
  // Always non-empty: transforms the feature stays gated by `enabled`, but the
  // hotkey itself must always carry a valid combo (Ctrl+Shift+T) so the
  // conflict checker can compare against it and the recorder UI never renders
  // an empty chip. The transform can still be invoked from the UI.
  hotkey: z.string().min(1).default("LCtrl+LShift+T").catch("LCtrl+LShift+T"),
  // User-configurable text transforms. Each entry carries its own prompt
  // and optional hotkey. Built-in entries (see `BUILTIN_TRANSFORMS`) carry
  // `builtin: true` so the UI can show a Reset action instead of Delete.
  prompts: z.array(transformSchema).default([]),
});

export const llmSettingsSchema = z.object({
  // Shared infrastructure (one Ollama instance, one OpenRouter account).
  endpoint: z.string().url().default("http://localhost:11434"),
  openrouterApiKey: z.string().default(""),
  // Per-feature config — each independently picks provider + model.
  // The feature runs iff its own `enabled` is true AND a model is configured;
  // there is no master switch (the IPC layer treats "no model" as off).
  dictation: llmDictationSchema.prefault({}),
  transforms: llmTransformsSchema.prefault({}),
  // Client-side request timeout (ms). Wired through but currently NOT applied
  // at the network layer — local LLMs (Ollama cold start) routinely exceed any
  // finite cap, and a silent abort + un-processed-text paste is misleading.
  // Kept here so the persisted setting / IPC plumbing / tests stay stable.
  timeout: z.number().int().min(1000).max(30_000).default(5000),
});

// Per-provider integration record. `apiKey` is encrypted at rest via
// the reference `safeStorage` (DPAPI on Windows) — the wire/in-memory shape
// is plaintext but the persisted JSON contains `enc:v1:<base64>`; the
// secret-storage layer transparently encrypts on save and decrypts on
// read (see `electron/lib/secret-storage.ts`). `verified` is the result
// of the last successful probe (null = never probed); `lastVerifiedAt`
// is epoch-ms. Matches the existing `llm.openrouterApiKey` pattern so
// the UI can use `PasswordField` directly against the store value.
const providerIntegrationStatusSchema = z.object({
  apiKey: z.string().default(""),
  verified: z.boolean().nullable().default(null),
  lastVerifiedAt: z.number().nullable().default(null),
});

const integrationsSchema = z.object({
  openai: providerIntegrationStatusSchema.prefault({}),
  elevenlabs: providerIntegrationStatusSchema.prefault({}),
});

// Kokoro-82M ONNX text-to-speech. Opt-in feature — `enabled` defaults to
// false; the engine only loads on first synthesis request. `voice` and
// `lang` mirror the Kokoro voice catalog (see
// ``server/src/synthesizer/infrastructure/voice_catalog.py``); `speed` is
// a multiplier clamped 0.5..2.0. `hotkey` is the global combo that
// captures the active selection and reads it aloud; defaults to
// LMeta+LShift+E so the binding is always present when TTS is enabled
// (users can rebind from settings). There is no per-TTS compute device:
// the synthesizer shares the main STT model's device (`model.device`),
// which the spawn layer mirrors onto the server's `--tts-device` flag.
export const ttsSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  // Local TTS catalog id selecting WHICH engine/model synthesizes (Kokoro,
  // Kitten, Piper, Supertonic). `voice` below is the voice WITHIN this model.
  // Default "kokoro-82m" preserves the historical Kokoro-only behaviour.
  model: z.string().default("kokoro-82m"),
  voice: z.string().default("af_heart"),
  lang: z.string().default("en-us"),
  speed: z.number().min(0.5).max(2.0).default(1.0),
  // Always non-empty: TTS the feature stays gated by `enabled`, but the
  // hotkey itself must always carry a valid combo so the conflict checker
  // can compare against it and the recorder UI never renders an empty chip.
  hotkey: z.string().min(1).default("LMeta+LShift+E").catch("LMeta+LShift+E"),
  // Local ⇄ Cloud switch mirroring the STT/LLM source toggles. "local" =
  // Kokoro ONNX (the `voice`/`lang`/`speed` fields above); "cloud" routes
  // synthesis through ElevenLabs entirely in the reference main process (see
  // `electron/ipc/tts-cloud.ts`). Cloud is only selectable when the
  // ElevenLabs key is present AND verified (`integrations.elevenlabs.verified`);
  // the renderer gates the option, and the cloud path reuses the same
  // encrypted `integrations.elevenlabs.apiKey` secret — no new key storage.
  source: z.enum(["local", "cloud"]).default("local"),
  // ElevenLabs tuning, active only when `source === "cloud"`. `voice` is the
  // account voice_id (fetched live via /v2/voices, so cloned voices appear);
  // `model` is one of the streaming-PCM-capable model ids (see
  // `widgets/tts-settings/config/cloud-tts-models`). `stability`/`similarity`/`style` are the
  // 0..1 voice-settings knobs, `speed` the 0.7..1.2 multiplier, and
  // `speakerBoost` the use_speaker_boost flag — passed verbatim into the
  // ElevenLabs `voice_settings` payload. `.prefault({})` lets the whole
  // sub-object default cleanly when absent from persisted JSON.
  cloud: z
    .object({
      voice: z.string().default(""),
      model: z.string().default("eleven_multilingual_v2"),
      stability: z.number().min(0).max(1).default(0.5),
      similarity: z.number().min(0).max(1).default(0.75),
      style: z.number().min(0).max(1).default(0),
      speed: z.number().min(0.7).max(1.2).default(1.0),
      speakerBoost: z.boolean().default(true),
    })
    .prefault({}),
});

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function migrateLegacyGlobalSettings(payload: unknown): unknown {
  const root = objectRecord(payload);
  if (!root) {
    return payload;
  }
  const model = objectRecord(root.model);
  const legacyTimeout = model?.modelUnloadTimeout;
  if (legacyTimeout === undefined) {
    return payload;
  }
  const global = objectRecord(root.global);
  if (global?.modelUnloadTimeout !== undefined) {
    return payload;
  }
  return {
    ...root,
    global: {
      ...(global ?? {}),
      modelUnloadTimeout: legacyTimeout,
    },
  };
}

const appSettingsBaseSchema = z.object({
  global: globalSettingsSchema.prefault({}),
  model: modelSettingsSchema.prefault({}),
  quality: qualitySettingsSchema.prefault({}),
  audio: audioSettingsSchema.prefault({}),
  general: generalSettingsSchema.prefault({}),
  hotkey: hotkeySettingsSchema.prefault({}),
  // `.catch([])` is the migration safety net: any persisted entry from the
  // pre-v10 shape (find/replace/caseSensitive/wholeWord) will fail the new
  // `term`-only parser and bring the whole array with it. The catch maps
  // the failure to an empty array, matching the agreed-upon wipe semantics.
  dictionary: z.array(dictionaryEntrySchema).default([]).catch([]),
  snippets: z.array(snippetEntrySchema).default([]),
  llm: llmSettingsSchema.prefault({}),
  tts: ttsSettingsSchema.prefault({}),
  integrations: integrationsSchema.prefault({}),
});

export const appSettingsSectionSchemas = appSettingsBaseSchema.shape;

export const appSettingsSchema = z.preprocess(
  migrateLegacyGlobalSettings,
  appSettingsBaseSchema,
);

export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
