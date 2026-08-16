import { z } from "zod";

// Kokoro-82M ONNX text-to-speech. Opt-in feature — `enabled` defaults to
// false; the engine only loads on first synthesis request. `voice` and
// `lang` mirror the Kokoro voice catalog; `speed` is
// a multiplier clamped to the active engine (0.4..1.3 for Supertonic,
// otherwise 0.5..2.0). `hotkey` is the global combo that
// captures the active selection and reads it aloud; defaults to
// LCtrl+Space so the binding is always present when TTS is enabled
// (users can rebind from settings). There is no per-TTS compute device:
// the synthesizer shares the main STT model's device (`model.device`).
export const ttsSettingsSchema = z.object({
	enabled: z.boolean().default(false),
	// Local TTS catalog id selecting WHICH engine/model synthesizes (Kokoro,
	// Kitten, Piper, Supertonic). `voice` below is the voice WITHIN this model.
	// Kokoro is the bundled default local voice model.
	model: z.string().default("kokoro-82m"),
	voice: z.string().default("af_heart"),
	// Reference-clip transcript for cloning models that need it (cloning ===
	// "zero_shot_audio_transcript", e.g. Spark). Auto-filled by transcribing the
	// uploaded reference with the selected STT model, then user-editable. Mirrors
	// the Rust `TtsSettings.clone_ref_text` default (empty) for the parity gate.
	cloneRefText: z.string().default(""),
	// Natural-language style instruction for rows whose prompt carries a dedicated
	// instruct span ALONGSIDE the voice (catalog `voiceInstruct`, e.g. OmniVoice).
	// Voice-DESIGN rows are different: there the prompt IS the voice and overloads
	// `voice`, which a cloning row cannot use because it holds the clip path.
	// Mirrors the Rust `TtsSettings.voice_instruct` default for the parity gate.
	voiceInstruct: z.string().default(""),
	// Selected weight precision for the local TTS model (mirrors the STT
	// `model.onnxQuantization` field). Empty string = the model's own default
	// quant, resolved server-side (e.g. Qwen3-TTS-VoiceDesign → "int4"); concrete
	// tiers ("int4"/"fp16"/"fp32") pass through verbatim. Kept generic so every
	// engine's precision shelf persists its selection through one field. Default
	// MUST mirror the canonical Rust default (`TtsSettings.quantization`),
	// enforced by the Rust↔zod parity gate (`defaults-parity.test.ts`).
	quantization: z.string().default(""),
	lang: z.string().default("en-us"),
	// Route the read-aloud text through the post-processing LLM first, so it can
	// insert the selected model's INLINE PARALINGUISTIC TAGS (`<laugh>`, `[sigh]`,
	// …) where the delivery calls for them. Off by default: it costs an LLM
	// round-trip before the first word is spoken, and only two shipped engines
	// (Orpheus, Chatterbox Turbo) have a tag vocabulary at all. The allowed tags
	// AND their delimiters come from the selected model's catalog row — this flag
	// only says "do it", never which syntax. Mirrors the Rust
	// `TtsSettings.inline_tags` default (false) for the parity gate.
	inlineTags: z.boolean().default(false),
	// Floor 0.4 matches Supertonic's widened slider (SUPERTONIC_SPEED_MIN); other
	// engines' sliders still start at 0.5, but the stored value must accept 0.4 so
	// a Supertonic selection persists without being rejected back to the default.
	// `.catch(1.0)`: a persisted out-of-range speed must reset only itself, not
	// nuke the whole `tts` section to defaults on decode.
	speed: z.number().min(0.4).max(2.0).default(1.0).catch(1.0),
	// Always non-empty: TTS the feature stays gated by `enabled`, but the
	// hotkey itself must always carry a valid combo so the conflict checker
	// can compare against it and the recorder UI never renders an empty chip.
	hotkey: z.string().min(1).default("LCtrl+Space").catch("LCtrl+Space"),
	// Local ⇄ Cloud switch mirroring the STT/LLM source toggles. "local" =
	// Kokoro ONNX (the `voice`/`lang`/`speed` fields above); "cloud" routes
	// synthesis through ElevenLabs entirely in the main process.
	// Cloud is only selectable when the
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
			// Which cloud TTS provider the Cloud source uses. ElevenLabs (account
			// voices) or OpenRouter (dedicated /audio/speech models, reusing the
			// shared `llm.openrouterApiKey`).
			provider: z.enum(["elevenlabs", "openrouter"]).default("elevenlabs"),
			voice: z.string().default(""),
			model: z.string().default("eleven_multilingual_v2"),
			// OpenRouter speech model id (e.g. "microsoft/mai-voice-2"), active when
			// provider === "openrouter". Dynamic — picker scans output_modalities=speech.
			openrouterModel: z.string().default(""),
			// OpenRouter voice id from the selected model's supported_voices catalog.
			openrouterVoice: z.string().default(""),
			stability: z.number().min(0).max(1).default(0.5).catch(0.5),
			similarity: z.number().min(0).max(1).default(0.75).catch(0.75),
			style: z.number().min(0).max(1).default(0).catch(0),
			speed: z.number().min(0.7).max(1.2).default(1.0).catch(1.0),
			speakerBoost: z.boolean().default(true),
		})
		.prefault({}),
});

// Per-provider integration record. `apiKey` is encrypted at rest via
// the OS keystore (DPAPI on Windows) — the wire/in-memory shape
// is plaintext but the persisted JSON contains `enc:v1:<base64>`; the
// secret-storage layer transparently encrypts on save and decrypts on
// read. `verified` is the result
// of the last successful probe (null = never probed); `lastVerifiedAt`
// is epoch-ms. Matches the existing `llm.openrouterApiKey` pattern so
// the UI can use `PasswordField` directly against the store value.
const providerIntegrationStatusSchema = z.object({
	apiKey: z.string().default(""),
	verified: z.boolean().nullable().default(null),
	lastVerifiedAt: z.number().nullable().default(null),
});

export const integrationsSchema = z.object({
	elevenlabs: providerIntegrationStatusSchema.prefault({}),
});
