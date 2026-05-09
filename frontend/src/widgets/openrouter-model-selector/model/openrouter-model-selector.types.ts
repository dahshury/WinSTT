import type { OpenRouterModel } from "@/shared/api/models";
import type { ModelExclusionConfig } from "../lib/model-exclusion";

export interface OpenRouterModelSelectorProps {
	description?: string;
	disabled?: boolean;
	/** Specific model IDs to hide from the list (e.g., the primary model when this selector is for a fallback). */
	disabledModelIds?: readonly string[];
	/** Tooltip / explanation shown to the user when they try to interact with a disabled model. Reserved for future UI. */
	disabledReason?: string;
	/**
	 * Exclusion configuration for fallback selectors. When a primary model has been chosen,
	 * the fallback selector should refuse to pick the same one. Compute via
	 * `computeModelExclusionConfig(primaryValue)` from the same lib.
	 */
	exclusionConfig?: ModelExclusionConfig;
	/** When true, this selector is acting as a fallback. Currently informational. */
	fallback?: boolean;
	isLoading?: boolean;
	label?: string;
	models: OpenRouterModel[];
	onChange: (value: string) => void;
	placeholder?: string;
	value: string;
}
