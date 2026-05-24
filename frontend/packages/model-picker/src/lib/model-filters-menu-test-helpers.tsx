"use client";

import { AuthorFilterSubmenu } from "../ui/AuthorFilterSubmenu";
import { EndpointProviderFilterSubmenu } from "../ui/EndpointProviderFilterSubmenu";
import type { ModelVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";

interface ActiveFilterCountInput {
	selectedEndpointProvider: string | null;
	selectedMakers: string[];
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
}

export function countNonNull(value: unknown): number {
	return value === null ? 0 : 1;
}

export function computeActiveFilterCount(input: ActiveFilterCountInput): number {
	return (
		countNonNull(input.selectedVariant) +
		countNonNull(input.selectedEndpointProvider) +
		input.selectedParameters.length +
		input.selectedMakers.length
	);
}

export function getActiveFiltersAttr(count: number): number | undefined {
	return count > 0 ? count : undefined;
}

export function getOpenStateAttr(isOpen: boolean): "open" | "closed" {
	return isOpen ? "open" : "closed";
}

interface MaybeAuthorSubmenuProps {
	allProviders: string[];
	favoriteProviders: string[];
	onMakersChange?: ((makers: string[]) => void) | undefined;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	providerCounts: Map<string, number>;
	selectedMakers: string[];
}

export function shouldRenderAuthorSubmenu(
	allProviders: string[],
	onMakersChange: ((makers: string[]) => void) | undefined
): boolean {
	return allProviders.length > 0 && !!onMakersChange;
}

export function shouldRenderEndpointSubmenu(endpointProviders: [string, number][]): boolean {
	return endpointProviders.length > 0;
}

export function MaybeAuthorSubmenu(props: MaybeAuthorSubmenuProps) {
	if (!shouldRenderAuthorSubmenu(props.allProviders, props.onMakersChange)) {
		return null;
	}
	return (
		<AuthorFilterSubmenu
			allProviders={props.allProviders}
			favoriteProviders={props.favoriteProviders}
			onMakersChange={props.onMakersChange!}
			onToggleFavorite={props.onToggleFavorite}
			providerCounts={props.providerCounts}
			selectedMakers={props.selectedMakers}
		/>
	);
}

interface MaybeEndpointSubmenuProps {
	endpointProviders: [string, number][];
	onEndpointProviderSelect: (provider: string | null) => void;
	selectedEndpointProvider: string | null;
}

export function MaybeEndpointSubmenu(props: MaybeEndpointSubmenuProps) {
	if (!shouldRenderEndpointSubmenu(props.endpointProviders)) {
		return null;
	}
	return (
		<EndpointProviderFilterSubmenu
			endpointProviders={props.endpointProviders}
			onEndpointProviderSelect={props.onEndpointProviderSelect}
			selectedEndpointProvider={props.selectedEndpointProvider}
		/>
	);
}

export const __model_filters_menu_test_helpers__ = {
	countNonNull,
	computeActiveFilterCount,
	getActiveFiltersAttr,
	getOpenStateAttr,
	shouldRenderAuthorSubmenu,
	shouldRenderEndpointSubmenu,
	MaybeAuthorSubmenu,
	MaybeEndpointSubmenu,
};
