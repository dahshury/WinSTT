import type { components } from "@spec/schema";
import type {
	AudioDevicePayload,
	GpuInfoEntry,
	OllamaModelPayload,
	OllamaScanResultPayload,
	OpenRouterModelPayload,
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
// Field names already matched @spec byte-for-byte (`modifiedAt`, `details`,
// `parameterSize`, …); the only drift is nullability (`?: T | null` here vs
// `?: T` in @spec), absorbed at the call sites via `?? 0` / `?.` guards.
export type OllamaModel = OllamaModelPayload;
export type OllamaScanResult = OllamaScanResultPayload;

// These Ollama catalog/library concepts are renderer-side scraping results with
// NO Rust command that returns them as a typed payload, so they stay on the
// frozen OpenAPI spec.
export type OllamaDetectResult = components["schemas"]["OllamaDetectResult"];
export type OllamaPullProgress = components["schemas"]["OllamaPullProgress"];
export type OllamaPullProgressStatus = components["schemas"]["OllamaPullProgressStatus"];
export type OllamaPullResult = components["schemas"]["OllamaPullResult"];
export type OllamaDeleteResult = components["schemas"]["OllamaDeleteResult"];
export type RecommendedOllamaModel = components["schemas"]["RecommendedOllamaModel"];
export type OllamaLibraryHit = components["schemas"]["OllamaLibraryHit"];
export type OllamaLibraryCatalogResult = components["schemas"]["OllamaLibraryCatalogResult"];
export type OllamaLibraryTag = components["schemas"]["OllamaLibraryTag"];
export type OllamaLibraryTagsResult = components["schemas"]["OllamaLibraryTagsResult"];

// ── OpenRouter ──────────────────────────────────────────────────────────────
// The Rust command (`scan_openrouter_models`) types `pricing` and
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
export interface OpenRouterModel extends Pick<OpenRouterModelPayload, "id" | "name"> {
	architecture?: OpenRouterArchitecture;
	context_length?: number;
	description?: string;
	endpoints?: OpenRouterEndpoint[];
	maker?: string;
	model_name?: string;
	pricing?: OpenRouterPricing;
	provider?: string;
	supported_parameters?: string[];
	variant?: OpenRouterVariant | null;
}

/** `scan_openrouter_models` result the picker store consumes. */
export interface OpenRouterScanResult {
	error?: string;
	models: OpenRouterModel[];
	reachable: boolean;
}

// ── Cloud STT ────────────────────────────────────────────────────────────────
// `verifyCloudSttCredential` returns `CloudSttVerifyPayload` ({ ok, code,
// message }) in bindings, but it types `code` as a bare `string | null` — it
// does NOT expose the closed `CloudSttProvider` / `CloudSttErrorCode` literal
// unions the renderer relies on (exhaustive `Record<CloudSttProvider, …>`,
// `code === "network"` routing). There is no Rust command emitting those as
// typed enums, so they stay on the frozen OpenAPI spec.
export type CloudSttProvider = components["schemas"]["CloudSttProvider"];
export type CloudSttErrorCode = components["schemas"]["CloudSttErrorCode"];

// ── Python-WS-only concepts with no Rust command (kept on @spec) ─────────────
export type ServerStatus = components["schemas"]["ServerStatus"];
export type AllowedParameter = components["schemas"]["AllowedParameter"];
export type AllowedMethod = components["schemas"]["AllowedMethod"];
export type AppSettingsSaveInput = components["schemas"]["AppSettings"];

// LLM warmup status (main → renderer broadcast describing the latest probe
// against the user's configured Ollama endpoint). Defined renderer-side
// because the main-process broadcaster isn't wired yet — see
// `frontend/src/widgets/llm-settings/{api/use-warmup-status-feed,model/warmup-status-store}.ts`.
// When OpenAPI gains a schema for this payload, move it under
// `components["schemas"]` like the others.
// `"loading"` is a transient outcome broadcast at the start of a warmup
// pass (paired with `LlmWarmupStatus.inProgress === true`). Other outcomes
// are terminal. `"unreachable"` and `"skipped"` mirror the main-process
// shape exactly so a narrow type guard works on either side.
type LlmWarmupOutcome =
	| "ok"
	| "model-not-found"
	| "load-failed"
	| "unreachable"
	| "skipped"
	| "loading";

export interface LlmWarmupModelStatus {
	errorBody?: string;
	model: string;
	outcome: LlmWarmupOutcome;
}

export interface LlmWarmupStatus {
	endpoint: string;
	/**
	 * True on the leading broadcast that fires when a warmup pass kicks
	 * off; false on the trailing broadcast that carries terminal outcomes.
	 * The renderer's swap tracker uses this to keep the spinner up during
	 * slow model loads instead of pre-empting them with a safety timeout.
	 */
	inProgress: boolean;
	models: LlmWarmupModelStatus[];
	ollamaInstalled: boolean;
	reachable: boolean;
	timestamp: number;
}
