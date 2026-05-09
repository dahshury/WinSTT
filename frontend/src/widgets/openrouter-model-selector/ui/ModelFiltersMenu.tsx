"use client";

import { FilterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { computeModelFiltersMetadata } from "../lib/model-filters-metadata";
import type { ModelVariant } from "../lib/model-variant-utils";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";
import { AuthorFilterSubmenu } from "./AuthorFilterSubmenu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./DropdownMenu";
import { EndpointProviderFilterSubmenu } from "./EndpointProviderFilterSubmenu";
import { ParametersFilterSubmenu } from "./ParametersFilterSubmenu";
import { VariantFilterSubmenu } from "./VariantFilterSubmenu";

export interface ModelFiltersMenuProps {
	allProviders?: string[];
	className?: string;
	favoriteProviders?: string[];
	models: OpenRouterModel[];
	onEndpointProviderSelect: (provider: string | null) => void;
	onMakersChange?: (makers: string[]) => void;
	onParametersChange: (params: FilterableParameter[]) => void;
	onToggleFavorite?: (maker: string) => void;
	onVariantSelect: (variant: ModelVariant | "none" | null) => void;
	selectedEndpointProvider: string | null;
	selectedMakers?: string[];
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
}

const NO_PROVIDERS: readonly string[] = Object.freeze([]);

interface ActiveFilterCountInput {
	selectedEndpointProvider: string | null;
	selectedMakers: string[];
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
}

function countNonNull(value: unknown): number {
	return value === null ? 0 : 1;
}

function computeActiveFilterCount(input: ActiveFilterCountInput): number {
	return (
		countNonNull(input.selectedVariant) +
		countNonNull(input.selectedEndpointProvider) +
		input.selectedParameters.length +
		input.selectedMakers.length
	);
}

function getActiveFiltersAttr(count: number): number | undefined {
	return count > 0 ? count : undefined;
}

function getOpenStateAttr(isOpen: boolean): "open" | "closed" {
	return isOpen ? "open" : "closed";
}

interface MaybeAuthorSubmenuProps {
	allProviders: string[];
	favoriteProviders: string[];
	onMakersChange?: (makers: string[]) => void;
	onToggleFavorite?: (maker: string) => void;
	providerCounts: Map<string, number>;
	selectedMakers: string[];
}

function MaybeAuthorSubmenu(props: MaybeAuthorSubmenuProps) {
	if (props.allProviders.length === 0) {
		return null;
	}
	if (!props.onMakersChange) {
		return null;
	}
	return (
		<AuthorFilterSubmenu
			allProviders={props.allProviders}
			favoriteProviders={props.favoriteProviders}
			onMakersChange={props.onMakersChange}
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

function MaybeEndpointSubmenu(props: MaybeEndpointSubmenuProps) {
	if (props.endpointProviders.length === 0) {
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

const TRIGGER_CLASS_BASE =
	"inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-none border-0 bg-transparent p-0 text-foreground-secondary outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent";

export function ModelFiltersMenu({
	models,
	selectedVariant,
	onVariantSelect,
	selectedEndpointProvider,
	onEndpointProviderSelect,
	selectedParameters,
	onParametersChange,
	allProviders = NO_PROVIDERS as string[],
	selectedMakers = NO_PROVIDERS as string[],
	onMakersChange,
	favoriteProviders = NO_PROVIDERS as string[],
	onToggleFavorite,
	className,
}: ModelFiltersMenuProps) {
	const [isOpen, setIsOpen] = useState(false);

	const metadata = computeModelFiltersMetadata(models);
	const { availableVariants, variantCounts, endpointProviders, providerCounts, parameterCounts } =
		metadata;

	const activeFilterCount = computeActiveFilterCount({
		selectedEndpointProvider,
		selectedMakers,
		selectedParameters,
		selectedVariant,
	});

	const handleVariantSelect = (variant: ModelVariant | "none" | null) => {
		onVariantSelect(variant);
		setIsOpen(false);
	};

	const handleEndpointProviderSelect = (provider: string | null) => {
		onEndpointProviderSelect(provider);
		setIsOpen(false);
	};

	return (
		<DropdownMenu modal={false} onOpenChange={setIsOpen} open={isOpen}>
			<DropdownMenuTrigger
				aria-label="Open filter menu"
				className={cn(TRIGGER_CLASS_BASE, className)}
				data-active-filters={getActiveFiltersAttr(activeFilterCount)}
				data-slot="model-filters-menu-trigger"
				data-state={getOpenStateAttr(isOpen)}
			>
				<HugeiconsIcon aria-hidden="true" className="size-3.5" icon={FilterIcon} />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="relative w-56 overflow-hidden"
				data-slot="model-filters-menu-content"
				side="right"
				sideOffset={4}
			>
				<VariantFilterSubmenu
					availableVariants={availableVariants}
					onVariantSelect={handleVariantSelect}
					selectedVariant={selectedVariant}
					variantCounts={variantCounts}
				/>
				<MaybeAuthorSubmenu
					allProviders={allProviders}
					favoriteProviders={favoriteProviders}
					onMakersChange={onMakersChange}
					onToggleFavorite={onToggleFavorite}
					providerCounts={providerCounts}
					selectedMakers={selectedMakers}
				/>
				<ParametersFilterSubmenu
					onParametersChange={onParametersChange}
					parameterCounts={parameterCounts}
					selectedParameters={selectedParameters}
				/>
				<MaybeEndpointSubmenu
					endpointProviders={endpointProviders}
					onEndpointProviderSelect={handleEndpointProviderSelect}
					selectedEndpointProvider={selectedEndpointProvider}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export const __model_filters_menu_test_helpers__ = {
	countNonNull,
	computeActiveFilterCount,
	getActiveFiltersAttr,
	getOpenStateAttr,
};
