import type { FilterableParameter } from "./openrouter-provider-utils";

export function toggleParameterValue(
	current: FilterableParameter[],
	param: FilterableParameter,
	selectedSet: Set<FilterableParameter>,
): FilterableParameter[] {
	if (selectedSet.has(param)) {
		return current.filter((p) => p !== param);
	}
	return [...current, param];
}

export function getParamCount(
	parameterCounts: Map<FilterableParameter, number>,
	param: FilterableParameter,
): number {
	return parameterCounts.get(param) ?? 0;
}

export function shouldShowCountBadge(count: number): boolean {
	return count > 0;
}

export function shouldShowClearAll(selectedCount: number): boolean {
	return selectedCount > 0;
}
