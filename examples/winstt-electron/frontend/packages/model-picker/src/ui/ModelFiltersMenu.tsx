"use client";

import {
	ArrowUpDownIcon,
	BookOpen02Icon,
	CheckmarkCircle02Icon,
	FilterIcon,
	Tag01Icon,
	TextFontIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useState } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import {
	computeActiveFilterCount,
	getActiveFiltersAttr,
	getOpenStateAttr,
	MaybeAuthorSubmenu,
	MaybeEndpointSubmenu,
} from "../lib/model-filters-menu-test-helpers";
import { computeModelFiltersMetadata } from "../lib/model-filters-metadata";
import type { ModelVariant } from "../lib/model-variant-utils";
import type { FilterableParameter } from "../lib/openrouter-provider-utils";
import {
	OPENROUTER_SORT_CHIP_LABEL,
	OPENROUTER_SORT_KEYS,
	type OpenRouterSortKey,
	type OpenRouterSortValue,
} from "../lib/openrouter-sort";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./DropdownMenu";
import { ParametersFilterSubmenu } from "./ParametersFilterSubmenu";
import { VariantFilterSubmenu } from "./VariantFilterSubmenu";

export interface ModelFiltersMenuProps {
	allProviders?: string[] | undefined;
	className?: string | undefined;
	favoriteProviders?: string[] | undefined;
	models: OpenRouterModel[];
	onEndpointProviderSelect: (provider: string | null) => void;
	onMakersChange?: ((makers: string[]) => void) | undefined;
	onParametersChange: (params: FilterableParameter[]) => void;
	onSortChange?: ((next: OpenRouterSortValue) => void) | undefined;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	onVariantSelect: (variant: ModelVariant | "none" | null) => void;
	selectedEndpointProvider: string | null;
	selectedMakers?: string[] | undefined;
	selectedParameters: FilterableParameter[];
	selectedVariant: ModelVariant | "none" | null;
	sortKey?: OpenRouterSortValue | undefined;
}

const NO_PROVIDERS: readonly string[] = Object.freeze([]);

/** Icon per sort dimension — kept in the UI layer so the sort lib stays
 *  presentation-free. */
const SORT_ICON: Record<OpenRouterSortKey, IconSvgElement> = {
	context: BookOpen02Icon,
	name: TextFontIcon,
	price: Tag01Icon,
};

function SortByGroup({
	onSortChange,
	sortKey,
}: {
	onSortChange: (next: OpenRouterSortValue) => void;
	sortKey: OpenRouterSortValue;
}) {
	return (
		<DropdownMenuGroup>
			<DropdownMenuLabel className="flex items-center gap-1.5">
				<HugeiconsIcon className="size-3.5" icon={ArrowUpDownIcon} />
				<span>Sort by</span>
			</DropdownMenuLabel>
			{OPENROUTER_SORT_KEYS.map((key) => {
				const isOn = sortKey === key;
				return (
					<DropdownMenuItem key={key} onClick={() => onSortChange(isOn ? null : key)}>
						<HugeiconsIcon className="me-2 size-4" icon={SORT_ICON[key]} />
						<span className="flex-1">{OPENROUTER_SORT_CHIP_LABEL[key]}</span>
						{isOn ? (
							<HugeiconsIcon className="ms-2 size-4 text-accent" icon={CheckmarkCircle02Icon} />
						) : null}
					</DropdownMenuItem>
				);
			})}
		</DropdownMenuGroup>
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
	sortKey = null,
	onSortChange,
}: ModelFiltersMenuProps) {
	const [isOpen, setIsOpen] = useState(false);

	const metadata = computeModelFiltersMetadata(models);
	const { availableVariants, variantCounts, endpointProviders, providerCounts, parameterCounts } =
		metadata;

	// The trigger badge counts filters + the active sort as one combined signal.
	const activeFilterCount =
		computeActiveFilterCount({
			selectedEndpointProvider,
			selectedMakers,
			selectedParameters,
			selectedVariant,
		}) + (sortKey === null ? 0 : 1);

	const handleSortChange = (next: OpenRouterSortValue) => {
		onSortChange?.(next);
		setIsOpen(false);
	};

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
				{onSortChange ? (
					<>
						<SortByGroup onSortChange={handleSortChange} sortKey={sortKey} />
						<DropdownMenuSeparator />
					</>
				) : null}
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
