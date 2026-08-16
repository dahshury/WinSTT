import { z } from "zod";

export const audioSettingsSchema = z.object({
	inputDeviceIndex: z.number().int().nullable().default(null),
	sampleRate: z.number().int().default(16_000),
	bufferSize: z.number().int().default(512),
	// Trip threshold = 1 - sileroSensitivity (see server SileroVad.detect).
	// Default 0.7 → trip > 0.3, the tuned threshold. Silero confidence on
	// far-mic speech routinely lives in 0.3–0.6. Per-device adaptive
	// calibration (`sileroSensitivityByDeviceName` below) adjusts from
	// this baseline.
	sileroSensitivity: z.number().min(0).max(1).default(0.7).catch(0.7),
	sileroUseOnnx: z.boolean().default(false),
	sileroDeactivityDetection: z.boolean().default(true),
	webrtcSensitivity: z.number().int().min(0).max(3).default(3).catch(3),
	postSpeechSilenceDuration: z
		.number()
		.min(0.1)
		.max(10)
		.default(0.7)
		.catch(0.7),
	minGapBetweenRecordings: z.number().default(0),
	preRecordingBufferDuration: z.number().default(1.0),
	// Per-device Silero sensitivity, keyed by input-device name. On device
	// switch we re-apply the selected device's stored value to the live
	// `sileroSensitivity` so each mic boots with its own last-known
	// sensitivity instead of whatever the previously-active device used.
	// Invalid persisted maps fall back without resetting the whole audio section.
	sileroSensitivityByDeviceName: z
		.record(z.string(), z.number().min(0).max(1))
		.default({})
		.catch({}),
	// Microphone preference order, as CPAL device NAMES (highest priority
	// first). Names — not indices — survive replug/enumeration reshuffles.
	// When non-empty, the effective microphone is the first entry that is
	// currently connected: the backend resolves it on every stream open, and
	// the renderer mirrors the same rule into `inputDeviceIndex` on hot-plug
	// so the pickers stay truthful. Empty = feature off (plain
	// `inputDeviceIndex` selection).
	inputDevicePriority: z.array(z.string()).default([]).catch([]),
	// CPAL input device index of the alternate microphone activated when the
	// laptop lid is closed (clamshell mode). When non-null, the backend
	// watches the platform lid state; on close it opens this input index,
	// and on open it restores the user's primary mic. Useful for
	// docked-laptop setups where the lid is shut and an external USB mic
	// is the only viable input. macOS uses
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
	// Invalid persisted values use the safe immediate-release default.
	microphoneRelease: z
		.enum(["always", "immediate", "sec30", "min1", "min5"])
		.default("immediate")
		.catch("immediate"),
	// Tail-of-recording capture window in ms applied to user-driven stops
	// (PTT release, toggle off). The mic keeps capturing for this many ms
	// before the pause + stop sequence runs, so trailing syllables that
	// escape just after the key-up still land in the buffer. 0 (default)
	// keeps stop behavior immediate; capped at 2000 ms so
	// a bad value can't lock the recorder. Mirrors the backend
	// `extra_recording_buffer_ms`.
	extraRecordingBufferMs: z.number().int().min(0).max(2000).default(0).catch(0),
});
