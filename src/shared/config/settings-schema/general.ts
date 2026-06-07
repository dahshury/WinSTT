import { z } from "zod";

// One entry in the recording-sound library. The default sound is implicit
// (never persisted); every entry here is a user-uploaded clip stored under
// `userData/sounds/`. `path` is the absolute path on disk; `name` is the
// display label (renamable independently of the on-disk filename).
export const soundLibraryEntrySchema = z.object({
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
	// Active recording sound. Empty string = original built-in default;
	// `builtin:<file>` = allow-listed bundled alternate; otherwise the absolute
	// path of an entry in `recordingSoundLibrary`.
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
		.default("dynamic-island")
		.catch("dynamic-island"),
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
	 * Context capture app scope:
	 * - `all-except-denied`: existing behavior; read every app unless it matches
	 *   `contextDenyList`.
	 * - `selected-only`: read only apps/sites that match `contextAllowList`.
	 *
	 * `.catch("all-except-denied")` preserves the historic privacy posture for
	 * stale or corrupt persisted values.
	 */
	contextAppMode: z
		.enum(["all-except-denied", "selected-only"])
		.default("all-except-denied")
		.catch("all-except-denied"),
	/**
	 * User-managed allow-list for selected-only context capture. Entries use the
	 * same matcher as the deny-list: executable basenames (`"chrome.exe"`) or URL
	 * host suffixes (`"docs.google.com"`). Empty means no app text is captured
	 * while selected-only mode is active.
	 */
	contextAllowList: z.array(z.string()).default([]).catch([]),
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
});
