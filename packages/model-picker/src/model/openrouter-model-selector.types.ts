import type { OpenRouterModel } from "@/shared/api/models";
import type {
	ReasoningEffort,
	Verbosity,
} from "../config/model-selector-options";
import type { ModelExclusionConfig } from "../lib/model-exclusion";

export interface OpenRouterModelSelectorProps {
	description?: string;
	disabled?: boolean;
	/** Specific model IDs to hide from the list (e.g., the primary model when this selector is for a fallback). */
	disabledModelIds?: readonly string[];
	/**
	 * Exclusion configuration for fallback selectors. When a primary model has been chosen,
	 * the fallback selector should refuse to pick the same one. Compute via
	 * `computeModelExclusionConfig(primaryValue)` from the same lib.
	 */
	exclusionConfig?: ModelExclusionConfig;
	isLoading?: boolean;
	label?: string;
	/** Optional max-output-tokens override. Renders only when a handler is supplied. */
	maxOutputTokens?: number | null;
	models: OpenRouterModel[];
	onChange: (value: string) => void;
	/** Called when the user edits the max-output-tokens field; presence enables the field. */
	onMaxOutputTokensChange?: (value: number | null) => void;
	/**
	 * Called when the dropdown opens. Use this to refresh the model catalog
	 * lazily so the user does not need to click a separate refresh button.
	 */
	onOpen?: () => void;
	/** Called when the user picks a different reasoning effort; presence enables the field. */
	onReasoningEffortChange?: (value: ReasoningEffort) => void;
	/** Called when the user picks a different verbosity; presence enables the field. */
	onVerbosityChange?: (value: Verbosity) => void;
	placeholder?: string;
	/** Current reasoning effort. Defaults to "medium" when undefined. */
	reasoningEffort?: ReasoningEffort;
	value: string;
	/** Current verbosity. Defaults to "medium" when undefined. */
	verbosity?: Verbosity;
}
