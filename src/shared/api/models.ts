import type {
	AudioDevicePayload,
	GpuInfoEntry,
	LlmWarmupModelStatus,
	LlmWarmupOutcome,
	LlmWarmupStatus,
	OllamaModelPayload,
	OllamaScanResultPayload,
	OpenRouterModelPayload,
	OpenRouterSttModelPayload,
	OpenRouterTtsModelPayload,
} from "@/bindings";

// Re-exported from the Rust contract (bindings.ts) so consumers get the real
// wire shape the live Tauri commands emit, instead of the deleted Python
// server's frozen OpenAPI spec. tauri-specta names every payload `*Payload`;
// we alias each back to the bare name the renderer already imports so call
// sites need no churn.
//
// There is NO case-transform layer on the invoke path (see ipc-client.ts /
// native-bridge-adapter.ts) so these aliases are the literal runtime shapes.
export type { AudioDevicePayload as AudioDevice };
export type { GpuInfoEntry as GpuInfo };

// ── Ollama (clean re-point to bindings) ────────────────────────────────────
// Field names match bindings byte-for-byte (`modifiedAt`, `details`,
// `parameterSize`, …); the only drift is nullability (`?: T | null` in bindings
// vs `?: T`), absorbed at the call sites via `?? 0` / `?.` guards.
export type OllamaModel = OllamaModelPayload;
export type OllamaScanResult = OllamaScanResultPayload;

// Ollama catalog/library + pull/detect/delete results. The Rust commands
// serialize their optional fields with `skip_serializing_if = Option::is_none`,
// so absent fields are genuinely absent (undefined) at runtime — never literal
// `null`. The generated bindings widen those to `?: T | null`; these consumers
// (llm-catalog-store / ollama-library-store) were written against the precise
// `?: T` shape, so we hand-mirror it here (an HONEST, narrower mirror than the
// over-declared bindings, and exactly what the deleted `@spec` types carried).

/** Coalesced status stage from the streaming `/api/pull` response. */
export type OllamaPullProgressStatus =
	| "pulling"
	| "downloading"
	| "verifying"
	| "writing"
	| "success"
	| "error"
	| "cancelled";

/** Streaming progress event for a model pull (`llm:pull-progress` channel). */
export interface OllamaPullProgress {
	model: string;
	status: OllamaPullProgressStatus;
	statusText?: string;
	digest?: string;
	completed?: number;
	total?: number;
	percent?: number;
	error?: string;
}

/** `ollama_detect` result. */
export interface OllamaDetectResult {
	installed: boolean;
	path?: string;
}

/** `ollama_pull` result. */
export interface OllamaPullResult {
	success: boolean;
	model: string;
	cancelled?: boolean;
	error?: string;
}

/** `ollama_delete` result. */
export interface OllamaDeleteResult {
	success: boolean;
	model: string;
	error?: string;
}

/** A single search hit scraped from ollama.com/library. */
export interface OllamaLibraryHit {
	name: string;
	description?: string;
	pulls?: string;
	updated?: string;
	capabilities?: string[];
}

/** `ollama_refresh_library` result — the full scraped library catalog. */
export interface OllamaLibraryCatalogResult {
	hits: OllamaLibraryHit[];
	error?: string;
}

/** A single pullable tag of a library model (e.g. `gemma3:4b`). */
export interface OllamaLibraryTag {
	name: string;
	sizeBytes?: number;
	sizeLabel?: string;
	contextWindow?: string;
	quantization?: string;
	parameterSize?: string;
	isLatest?: boolean;
}

/** `ollama_refresh_tags` result for a single library model. */
export interface OllamaLibraryTagsResult {
	model: string;
	tags: OllamaLibraryTag[];
	error?: string;
}

/**
 * A curated entry shown in the "Recommended" tab of the model manager.
 * Renderer-only — the recommended list is hardcoded client-side
 * (`entities/llm-catalog/lib/recommended-models.ts`) and has no Rust command,
 * so this is a hand-written mirror rather than a bindings re-point.
 */
export interface RecommendedOllamaModel {
	/** Ollama model identifier including tag (e.g. `llama3.2:1b`). */
	name: string;
	/** Human-readable name shown in the UI. */
	displayName: string;
	/** Model family (e.g. `llama`, `gemma`, `qwen`, `phi`). */
	family?: string;
	/** Parameter count label (e.g. `1.2B`, `3B`). */
	paramSize: string;
	/** Approximate on-disk size of the default quantization, in bytes. */
	sizeBytes: number;
	description: string;
	/** Free-form tags, e.g. `fast`, `tiny`, `instruct`. */
	tags?: string[];
}

// ── OpenRouter ──────────────────────────────────────────────────────────────
// The Rust command (`openrouter_refresh_models`) types `pricing` and
// `architecture` as opaque `serde_json::Value` (so bindings exposes them as
// `JsonValue | null`) and does NOT fan out per-model `/endpoints` enrichment
// (`endpoints` is absent at runtime — see the TODO in
// `src-tauri/src/winstt/commands/llm.rs`). The picker, ported 1:1 from
// the reference, still reads the *structured* OpenRouter JSON those opaque blobs
// actually carry (`pricing.prompt`, `architecture.input_modalities`) and the
// literal-union `variant`, plus guards `endpoints` as "always empty for now".
//
// So we keep the structured OpenRouter shapes as renderer-local interfaces
// (their structured form has no Rust equivalent — Rust passes the JSON through
// verbatim) and define `OpenRouterModel` as the bindings payload's scalar
// fields refined to those real shapes. The Rust struct serializes its
// `Option<_>` fields with `skip_serializing_if = "Option::is_none"`, so the
// absent-field shape is `T | undefined` (never the `| null` bindings
// over-declares) — matching what the renderer already assumes.

/** OpenRouter per-token pricing block (raw USD-per-unit strings). */
export interface OpenRouterPricing {
	completion?: string;
	image?: string;
	input_cache_read?: string;
	input_cache_write?: string;
	internal_reasoning?: string;
	prompt?: string;
	request?: string;
	web_search?: string;
}

/** OpenRouter architecture metadata — drives the modality chips in picker rows. */
export interface OpenRouterArchitecture {
	input_modalities?: string[];
	instruct_type?: string;
	modality?: string;
	output_modalities?: string[];
	tokenizer?: string;
}

/**
 * A per-provider endpoint for an OpenRouter model. Not emitted by the current
 * Rust command (enrichment is deferred), but the picker reads it defensively
 * (`model.endpoints ?? []`) so the type stays available for when it is.
 */
export interface OpenRouterEndpoint {
	context_length: number;
	max_completion_tokens?: number | null;
	model_name: string;
	name: string;
	pricing: OpenRouterPricing;
	provider_name: string;
	quantization?: string | null;
	status?: number | null;
	supported_parameters?: string[];
	tag: string;
	uptime_last_30m?: number | null;
}

/** OpenRouter `variant` tag — a closed literal union the picker filters on. */
export type OpenRouterVariant =
	| "exacto"
	| "extended"
	| "floor"
	| "free"
	| "nitro"
	| "online"
	| "thinking";

/**
 * A model from OpenRouter `/api/v1/models`. Anchored to the Rust
 * `OpenRouterModelPayload` for its REQUIRED fields (`id`, `name`) but with
 * every optional field re-declared to its real runtime shape: the Rust struct
 * serializes its `Option<_>` fields with `skip_serializing_if =
 * "Option::is_none"`, so the absent shape is `T | undefined` (never the `|
 * null` that bindings over-declares). The opaque `pricing`/`architecture`
 * blobs (`JsonValue | null` in bindings) are narrowed to their real structured
 * shapes and `variant` to its literal union; `endpoints` is renderer-only
 * (absent at runtime today, defensively read as `?? []`).
 */
export interface OpenRouterModel
	extends Pick<OpenRouterModelPayload, "id" | "name"> {
	architecture?: OpenRouterArchitecture;
	context_length?: number;
	description?: string;
	endpoints?: OpenRouterEndpoint[];
	/** Optional transcription guidance score, used when OpenRouter STT rows are adapted into the shared picker. */
	accuracy_score?: number;
	maker?: string;
	model_name?: string;
	pricing?: OpenRouterPricing;
	provider?: string;
	/** Optional transcription guidance score, used when OpenRouter STT rows are adapted into the shared picker. */
	speed_score?: number;
	supported_parameters?: string[];
	supported_voices?: string[];
	variant?: OpenRouterVariant | null;
}

/** `openrouter_refresh_models` result the picker store consumes. */
export interface OpenRouterScanResult {
	error?: string;
	models: OpenRouterModel[];
	reachable: boolean;
}

/**
 * A transcription model from OpenRouter
 * `/api/v1/models?output_modalities=transcription`. Anchored to the Rust
 * `OpenRouterSttModelPayload` with the card metadata needed by the shared
 * OpenRouter picker.
 */
export interface OpenRouterSttModel
	extends Pick<OpenRouterSttModelPayload, "id" | "name"> {
	accuracy_score: number;
	description?: string;
	endpoints?: OpenRouterEndpoint[];
	pricing?: OpenRouterPricing;
	speed_score: number;
}

/** `openrouter_refresh_stt_models` result the cloud STT picker store consumes. */
export interface OpenRouterSttScanResult {
	error?: string;
	models: OpenRouterSttModel[];
	reachable: boolean;
}

/**
 * A speech (TTS) model from OpenRouter `/api/v1/models?output_modalities=speech`.
 * Lean `{ id, name }` for the cloud TTS picker.
 */
export interface OpenRouterTtsModel
	extends Pick<OpenRouterTtsModelPayload, "id" | "name"> {
	description?: string;
	pricing?: OpenRouterPricing;
	quality_score: number;
	speed_score: number;
	supported_voices: string[];
}

/** `openrouter_refresh_tts_models` result the cloud TTS picker store consumes. */
export interface OpenRouterTtsScanResult {
	error?: string;
	models: OpenRouterTtsModel[];
	reachable: boolean;
}

// ── Cloud STT ────────────────────────────────────────────────────────────────
// `verifyCloudSttCredential` returns `CloudSttVerifyPayload` ({ ok, code,
// message }) in bindings, but it types `code` as a bare `string | null` — it
// does NOT expose the closed `CloudSttProvider` / `CloudSttErrorCode` literal
// unions the renderer relies on (exhaustive `Record<CloudSttProvider, …>`,
// `code === "network"` routing). The Rust `CloudSttErrorCode` enum
// (winstt/cloud_stt.rs) carries internal-only variants (`audio_too_large`,
// `aborted`, `timeout`) the renderer never receives, so deriving it would widen
// the union past what the UI handles. These mirror the renderer-facing subset —
// kept in lockstep with `schema.zod.ts`'s `CloudSttProvider`/`CloudSttErrorCode`.
export type CloudSttProvider = "elevenlabs" | "openrouter";
export type CloudSttErrorCode =
	| "auth"
	| "network"
	| "key_missing"
	| "rate_limit"
	| "provider_error";

/**
 * Cloud STT providers whose API key lives in `settings.integrations.<provider>`
 * (the STT-only provider: ElevenLabs — OpenAI was removed). Excludes `openrouter`,
 * which reuses the single LLM key (`settings.llm.openrouterApiKey`) and therefore
 * has NO `integrations` entry / credential-store row. Use this for any surface that
 * indexes `settings.integrations[provider]` or the cloud-STT credential store.
 */
export type IntegrationCloudProvider = Exclude<CloudSttProvider, "openrouter">;

// ── STT IPC parameter/method/status vocabularies ─────────────────────────────
// These mirror the dictation IPC surface (winstt_get_parameter / _set_parameter
// / winstt_call_method) and the server-status broadcast. They have no
// specta-emitted Rust source, so they are hand-mirrored here (kept in lockstep
// with `schema.zod.ts`'s `AllowedParameter` / `AllowedMethod` / `ServerStatus`).

/** STT server lifecycle status, broadcast on the `stt:server-status` channel. */
export type ServerStatus = "idle" | "starting" | "running" | "error";

/** Parameters accepted by `winstt_get_parameter` / `winstt_set_parameter`. */
export type AllowedParameter =
	| "model"
	| "language"
	| "silero_sensitivity"
	| "wake_word_activation_delay"
	| "post_speech_silence_duration"
	| "listen_start"
	| "recording_stop_time"
	| "last_transcription_bytes"
	| "last_transcription_bytes_b64"
	| "speech_end_silence_start"
	| "is_recording"
	| "use_wake_words"
	| "silence_timing"
	| "silence_endpoint_enabled"
	| "smart_endpoint_enabled"
	| "detection_speed"
	| "input_device_index"
	| "end_of_sentence_detection_pause"
	| "mid_sentence_detection_pause"
	| "unknown_sentence_detection_pause"
	| "initial_prompt"
	| "initial_prompt_realtime"
	| "onnx_quantization"
	| "translate_to_english"
	| "model_unload_timeout_seconds"
	| "webrtc_sensitivity"
	| "silero_deactivity_detection"
	| "always_on_microphone"
	| "lazy_stream_close"
	| "lazy_close_timeout_seconds";

/** Methods callable via `winstt_call_method`. */
export type AllowedMethod =
	| "set_microphone"
	| "abort"
	| "stop"
	| "clear_audio_queue"
	| "wakeup"
	| "shutdown"
	| "text"
	| "request_diarization_toggle";

/**
 * The settings payload accepted by the `SETTINGS_SAVE` IPC. The renderer's zod
 * `settingsSchema` is the canonical shape; this alias stays intentionally loose
 * (the IPC casts the validated settings object through it) so callers don't have
 * to thread the full schema type. See `shared/api/ipc/stt-audio.ts`.
 */
export type AppSettingsSaveInput = Record<string, unknown>;

// LLM warmup status is emitted by Rust commands and generated in bindings.ts.
export type { LlmWarmupModelStatus, LlmWarmupOutcome, LlmWarmupStatus };
