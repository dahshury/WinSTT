import { z } from "zod";
import {
	DeviceTypeSchema,
	TranscriberBackendSchema,
} from "@/shared/api/schema.zod";

const modelUnloadTimeoutSchema = z
	.enum(["immediately", "never", "min2", "min5", "min10", "min15", "hour1"])
	.default("min15")
	.catch("min15");

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
	autoDetectLanguage: z.boolean().default(false).catch(false),
	languageCandidates: z.array(z.string()).default([]).catch([]),
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

export const globalSettingsSchema = z.object({
	// Idle-timeout shared by local STT, realtime preview, local TTS, and
	// Ollama keep-alive. Default "min15".
	modelUnloadTimeout: modelUnloadTimeoutSchema,
});

export const qualitySettingsSchema = z.object({
	useMainModelForRealtime: z.boolean().default(false),
	realtimeProcessingPause: z.number().default(0.02),
	initRealtimeAfterSeconds: z.number().default(0.2),
	earlyTranscriptionOnSilence: z.number().default(0.2),
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

export const hotkeySettingsSchema = z.object({
	// `.catch("LCtrl+LMeta")` is the rescue path: if settings.json on disk
	// ever sneaks an empty string in (legacy data, hand-edit, sync conflict),
	// `.min(1)` would throw and `decodeSettingsPayload` would wipe the whole
	// `hotkey` section. Catch rehydrates to the documented default so the
	// PTT binding is always present and never empty.
	pushToTalkKey: z
		.string()
		.min(1)
		.default("LCtrl+LMeta")
		.catch("LCtrl+LMeta"),
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
	// True only for entries inserted by the LLM dictionary tool. Manual and
	// legacy entries omit the field and render as "Manual" in Settings.
	autoAdded: z.boolean().optional(),
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
