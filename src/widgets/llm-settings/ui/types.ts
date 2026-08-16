import type {
	OllamaFitAssessment,
	PausedPullState,
} from "@/entities/llm-catalog";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";

export type { TranslateFn } from "@/shared/i18n/translation-types";

// Re-uses the spec-generated shape so `details.parameterSize` /
// `details.quantizationLevel` flow through to the picker.
export type OllamaModel = import("@/shared/api/models").OllamaModel;

type LlmSettings = AppSettingsOutput["llm"];
type LlmDictation = LlmSettings["dictation"];
export type LlmProvider = LlmDictation["provider"];

// Derived from the settings schema so they can't drift from the persisted
// shape. `reasoningEffort` and `thinkingEffort` share the same off/low/medium/
// high scale and drive the same shared `ReasoningEffortDropdown`.
export type ReasoningEffort = LlmDictation["reasoningEffort"];
export type Verbosity = LlmDictation["verbosity"];

export type OllamaThinkingEffort = LlmDictation["thinkingEffort"];
export interface OllamaMutationResult {
	error?: string | undefined;
	success: boolean;
}

export interface OllamaPullBundle {
	cancelPull: (name: string) => void;
	deleteModel: (name: string) => Promise<OllamaMutationResult>;
	discardPausedPull: (name: string) => void;
	getFit: (sizeBytes: number) => OllamaFitAssessment;
	pausedPulls: Readonly<Record<string, PausedPullState>>;
	pullModel: (name: string) => Promise<OllamaMutationResult>;
	pulls: Readonly<
		Record<string, import("@/shared/api/models").OllamaPullProgress>
	>;
	resumePull: (name: string) => Promise<OllamaMutationResult>;
}

export interface OllamaCatalogState {
	error: string | null;
	isLoaded: boolean;
	isScanning: boolean;
	models: readonly OllamaModel[];
	scanModels: () => void;
}

export interface OpenRouterCatalogState {
	error: string | null;
	isLoaded: boolean;
	isScanning: boolean;
	models: readonly import("@/shared/api/models").OpenRouterModel[];
	scanModels: () => void;
}
