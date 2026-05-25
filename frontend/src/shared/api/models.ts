import type { components } from "@spec/schema";

export type AudioDevice = components["schemas"]["AudioDevice"];
export type GpuInfo = components["schemas"]["GpuInfo"];
export type ServerStatus = components["schemas"]["ServerStatus"];
export type AllowedParameter = components["schemas"]["AllowedParameter"];
export type AllowedMethod = components["schemas"]["AllowedMethod"];
export type AppSettingsSaveInput = components["schemas"]["AppSettings"];
export type OllamaModel = components["schemas"]["OllamaModel"];
export type OllamaScanResult = components["schemas"]["OllamaScanResult"];
export type OllamaDetectResult = components["schemas"]["OllamaDetectResult"];
export type OllamaPullProgress = components["schemas"]["OllamaPullProgress"];
export type OllamaPullProgressStatus = components["schemas"]["OllamaPullProgressStatus"];
export type OllamaPullResult = components["schemas"]["OllamaPullResult"];
export type OllamaDeleteResult = components["schemas"]["OllamaDeleteResult"];
export type RecommendedOllamaModel = components["schemas"]["RecommendedOllamaModel"];
export type OllamaLibraryHit = components["schemas"]["OllamaLibraryHit"];
export type OllamaLibrarySearchResult = components["schemas"]["OllamaLibrarySearchResult"];
export type OllamaLibraryCatalogResult = components["schemas"]["OllamaLibraryCatalogResult"];
export type OllamaLibraryTag = components["schemas"]["OllamaLibraryTag"];
export type OllamaLibraryTagsResult = components["schemas"]["OllamaLibraryTagsResult"];
export type OpenRouterModel = components["schemas"]["OpenRouterModel"];
export type OpenRouterEndpoint = components["schemas"]["OpenRouterEndpoint"];
export type OpenRouterPricing = components["schemas"]["OpenRouterPricing"];
export type OpenRouterScanResult = components["schemas"]["OpenRouterScanResult"];
export type CloudSttProvider = components["schemas"]["CloudSttProvider"];
export type CloudSttErrorCode = components["schemas"]["CloudSttErrorCode"];

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
