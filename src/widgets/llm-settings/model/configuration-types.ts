import type {
	BuiltinPresetEntry,
	CustomModifier,
} from "@/entities/llm-catalog";
import type { AppSettingsOutput } from "@/shared/config/settings-schema";

type LlmProvider = AppSettingsOutput["llm"]["dictation"]["provider"];
type ThinkingEffort = "off" | "low" | "medium" | "high";
type EffortLevel = "low" | "medium" | "high";

/** A complete post-processing profile, including model and request tuning. */
export interface LlmConfiguration {
	customModifiers: CustomModifier[];
	enabled: boolean;
	maxOutputTokens: number | null;
	model: string;
	openrouterFallbackModel: string;
	openrouterModel: string;
	presets: BuiltinPresetEntry[];
	provider: LlmProvider;
	reasoningEffort: ThinkingEffort;
	thinkingEffort: ThinkingEffort;
	verbosity: EffortLevel;
}

/** A user-named post-processing profile persisted by the configuration store. */
export interface SavedConfiguration {
	config: LlmConfiguration;
	id: string;
	name: string;
	version?: number;
}
