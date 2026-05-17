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

// LLM warmup status (main → renderer broadcast describing the latest probe
// against the user's configured Ollama endpoint). Defined renderer-side
// because the main-process broadcaster isn't wired yet — see
// `frontend/src/features/llm-warmup-status/`. When OpenAPI gains a schema
// for this payload, move it under `components["schemas"]` like the others.
export type LlmWarmupOutcome = "ok" | "model-not-found" | "load-failed";

export interface LlmWarmupModelStatus {
	errorBody?: string;
	model: string;
	outcome: LlmWarmupOutcome;
}

export interface LlmWarmupStatus {
	endpoint: string;
	models: LlmWarmupModelStatus[];
	ollamaInstalled: boolean;
	reachable: boolean;
	timestamp: number;
}
