"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import {
	ArrowUpDownIcon,
	FilterIcon,
	ServerStack01Icon,
	Settings01Icon,
	SparklesIcon,
	StarIcon,
	Tag01Icon,
	TextFontIcon,
	Tick01Icon,
	BookOpen02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import { useTranslations } from "use-intl";
import type { OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { getParameterIcon, getVariantIcon } from "../lib/filter-icons";
import { computeActiveFilterCount } from "../lib/model-filters-menu-utils";
import { computeModelFiltersMetadata } from "../lib/model-filters-metadata";
import { formatMaker } from "../lib/model-selector-utils";
import type { ModelVariant } from "../lib/model-variant-utils";
import {
	FILTERABLE_PARAMETERS,
	formatProviderName,
	PARAMETER_INFO,
	type FilterableParameter,
} from "../lib/openrouter-provider-utils";
import {
	OPENROUTER_SORT_CHIP_LABEL,
	OPENROUTER_SORT_KEYS,
	type OpenRouterSortKey,
	type OpenRouterSortValue,
} from "../lib/openrouter-sort";
import { getVariantLabel } from "./active-filters-bar-helpers";
import { FilterNavMenu, type FilterNavSection } from "./FilterNavMenu";

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

/** Icon per sort dimension - kept in the UI layer so the sort lib stays
 *  presentation-free. */
const SORT_ICON: Record<OpenRouterSortKey, IconSvgElement> = {
	context: BookOpen02Icon,
	name: TextFontIcon,
	price: Tag01Icon,
};

function toggleInArray<T>(list: readonly T[], item: T): T[] {
	return list.includes(item)
		? list.filter((candidate) => candidate !== item)
		: [...list, item];
}

function filterTextOptions(
	options: readonly string[],
	query: string,
	format: (value: string) => string,
): readonly string[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return options;
	}
	return options.filter((value) =>
		matchesFuzzySearch([format(value), value], normalized),
	);
}

function filterEndpointProviderEntries(
	providers: readonly [string, number][],
	query: string,
): readonly [string, number][] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return providers;
	}
	return providers.filter(([provider]) =>
		matchesFuzzySearch([formatProviderName(provider), provider], normalized),
	);
}

function OptionCount({ count }: { count: number | undefined }) {
	if (!count || count <= 0) {
		return null;
	}
	return (
		<span className="shrink-0 text-[10px] text-foreground-muted tabular-nums">
			{count}
		</span>
	);
}

function FilterChip({
	active,
	count,
	initialFocus = false,
	label,
	leading,
	onClick,
}: {
	active: boolean;
	count?: number | undefined;
	initialFocus?: boolean | undefined;
	label: string;
	leading?: ReactNode;
	onClick: () => void;
}) {
	const level = useSurface();
	const idleChip = cn(
		surfaceBg(Math.min(level + 1, 8)),
		surfaceHoverBg(Math.min(level + 2, 8)),
		"text-foreground-secondary ring-divider hover:text-foreground hover:ring-border",
	);
	return (
		<BaseButton
			aria-pressed={active}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-[11px] leading-none outline-none ring-1 transition-colors focus-visible:ring-2 focus-visible:ring-accent",
				active ? "bg-accent/15 text-accent ring-accent/40" : idleChip,
			)}
			data-nav-initial-focus={initialFocus ? "" : undefined}
			onClick={onClick}
			type="button"
		>
			{leading ? <span className="shrink-0">{leading}</span> : null}
			<span>{label}</span>
			<OptionCount count={count} />
		</BaseButton>
	);
}

function SortFilterSection({
	onSortChange,
	sortKey,
}: {
	onSortChange: (next: OpenRouterSortValue) => void;
	sortKey: OpenRouterSortValue;
}) {
	const t = useTranslations("modelPicker");
	const focusKey = sortKey ?? OPENROUTER_SORT_KEYS[0];
	return (
		<div className="flex flex-col gap-2 px-3 pt-1 pb-3">
			<p className="text-[11px] text-foreground-muted leading-snug">
				{t("flattenProviders")}
			</p>
			<div className="flex flex-wrap gap-1.5">
				{OPENROUTER_SORT_KEYS.map((key) => (
					<FilterChip
						active={sortKey === key}
						initialFocus={key === focusKey}
						key={key}
						label={OPENROUTER_SORT_CHIP_LABEL[key]}
						leading={
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3"
								icon={SORT_ICON[key]}
							/>
						}
						onClick={() => onSortChange(sortKey === key ? null : key)}
					/>
				))}
			</div>
		</div>
	);
}

function VariantFilterSection({
	availableVariants,
	onVariantSelect,
	selectedVariant,
	variantCounts,
}: {
	availableVariants: Array<ModelVariant | "none">;
	onVariantSelect: (variant: ModelVariant | "none" | null) => void;
	selectedVariant: ModelVariant | "none" | null;
	variantCounts: Map<ModelVariant | "none", number>;
}) {
	return (
		<div className="grid grid-cols-2 gap-1.5 px-3 pt-1 pb-3">
			<FilterChip
				active={selectedVariant === null}
				initialFocus={selectedVariant === null}
				label="All"
				leading={
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3"
						icon={FilterIcon}
					/>
				}
				onClick={() => onVariantSelect(null)}
			/>
			{availableVariants.map((variant) => (
				<FilterChip
					active={selectedVariant === variant}
					count={variantCounts.get(variant)}
					initialFocus={selectedVariant === variant}
					key={variant}
					label={getVariantLabel(variant)}
					leading={getVariantIcon(variant)}
					onClick={() => onVariantSelect(variant)}
				/>
			))}
		</div>
	);
}

function SearchInput({
	onChange,
	placeholder,
	value,
}: {
	onChange: (next: string) => void;
	placeholder: string;
	value: string;
}) {
	const level = useSurface();
	return (
		<div className="px-3 pt-1 pb-2">
			<input
				aria-label={placeholder}
				className={cn(
					"h-8 w-full rounded-md border border-border px-2.5 font-inherit text-body text-foreground leading-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
					surfaceBg(Math.min(level + 1, 8)),
				)}
				data-nav-initial-focus
				dir="ltr"
				onChange={(event) => onChange(event.target.value)}
				placeholder={placeholder}
				type="search"
				value={value}
			/>
		</div>
	);
}

function SelectedBox({ selected }: { selected: boolean }) {
	return (
		<span
			className={cn(
				"flex size-5 shrink-0 items-center justify-center rounded-md border",
				selected
					? "border-accent bg-accent text-on-accent"
					: "border-border/70 bg-surface-2",
			)}
		>
			{selected ? (
				<HugeiconsIcon
					aria-hidden="true"
					className="size-3"
					icon={Tick01Icon}
				/>
			) : null}
		</span>
	);
}

function AuthorRow({
	count,
	isFavorite,
	isSelected,
	onToggleFavorite,
	onToggleMaker,
	provider,
}: {
	count: number | undefined;
	isFavorite: boolean;
	isSelected: boolean;
	onToggleFavorite?: ((provider: string) => void) | undefined;
	onToggleMaker: (provider: string) => void;
	provider: string;
}) {
	return (
		<div
			className={cn(
				"flex min-h-9 items-center gap-2 rounded-lg p-1.5 transition-colors hover:bg-foreground/[0.045]",
				isSelected && "bg-accent/10",
			)}
		>
			<BaseButton
				className="flex min-w-0 flex-1 items-center gap-2 text-start"
				onClick={() => onToggleMaker(provider)}
				type="button"
			>
				<SelectedBox selected={isSelected} />
				<span className="min-w-0 flex-1 truncate text-body-sm">
					{formatMaker(provider)}
				</span>
				<OptionCount count={count} />
			</BaseButton>
			{onToggleFavorite ? (
				<BaseButton
					aria-label={
						isFavorite
							? "Remove from favorite authors"
							: "Add to favorite authors"
					}
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground-muted transition-colors hover:bg-foreground/[0.06]"
					onClick={() => onToggleFavorite(provider)}
					type="button"
				>
					<HugeiconsIcon
						aria-hidden="true"
						className={cn(
							"size-3.5",
							isFavorite && "fill-favorite text-favorite",
						)}
						icon={StarIcon}
					/>
				</BaseButton>
			) : null}
		</div>
	);
}

function AuthorFilterSection({
	favoriteProviders,
	filteredAuthors,
	onMakersChange,
	onToggleFavorite,
	onSearchChange,
	providerCounts,
	search,
	selectedMakers,
}: {
	favoriteProviders: string[];
	filteredAuthors: readonly string[];
	onMakersChange: (makers: string[]) => void;
	onSearchChange: (next: string) => void;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	providerCounts: Map<string, number>;
	search: string;
	selectedMakers: string[];
}) {
	const t = useTranslations("modelPicker");
	// Build Sets once so each row's favorite/selected lookup is O(1) instead of a
	// fresh `array.includes()` scan per rendered author.
	const favoriteSet = new Set(favoriteProviders);
	const selectedMakerSet = new Set(selectedMakers);
	return (
		<>
			<SearchInput
				onChange={onSearchChange}
				placeholder="Search authors"
				value={search}
			/>
			<div className="max-h-56 overflow-y-auto px-2 pb-2">
				<div className="flex flex-col gap-0.5">
					{filteredAuthors.length === 0 ? (
						<div className="py-4 text-center text-body-sm text-foreground-muted">
							{t("noAuthorsFound")}
						</div>
					) : null}
					{filteredAuthors.map((provider) => (
						<AuthorRow
							count={providerCounts.get(provider)}
							isFavorite={favoriteSet.has(provider)}
							isSelected={selectedMakerSet.has(provider)}
							key={provider}
							onToggleFavorite={onToggleFavorite}
							onToggleMaker={(maker) =>
								onMakersChange(toggleInArray(selectedMakers, maker))
							}
							provider={provider}
						/>
					))}
				</div>
			</div>
		</>
	);
}

function ParametersFilterSection({
	onParametersChange,
	parameterCounts,
	selectedParameters,
}: {
	onParametersChange: (params: FilterableParameter[]) => void;
	parameterCounts: Map<FilterableParameter, number>;
	selectedParameters: FilterableParameter[];
}) {
	return (
		<div className="flex flex-wrap gap-1.5 px-3 pt-1 pb-3">
			{FILTERABLE_PARAMETERS.map((param, index) => (
				<FilterChip
					active={selectedParameters.includes(param)}
					count={parameterCounts.get(param)}
					initialFocus={index === 0}
					key={param}
					label={PARAMETER_INFO[param].label}
					leading={getParameterIcon(param)}
					onClick={() =>
						onParametersChange(toggleInArray(selectedParameters, param))
					}
				/>
			))}
		</div>
	);
}

function ProviderRow({
	count,
	isSelected,
	label,
	onClick,
}: {
	count?: number | undefined;
	isSelected: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<BaseButton
			className={cn(
				"flex min-h-9 w-full items-center gap-2 rounded-lg p-1.5 text-start transition-colors hover:bg-foreground/[0.045]",
				isSelected && "bg-accent/10",
			)}
			onClick={onClick}
			type="button"
		>
			<SelectedBox selected={isSelected} />
			<span className="min-w-0 flex-1 truncate text-body-sm">{label}</span>
			<OptionCount count={count} />
		</BaseButton>
	);
}

function EndpointProviderFilterSection({
	filteredEndpointProviders,
	onEndpointProviderSelect,
	onSearchChange,
	search,
	selectedEndpointProvider,
}: {
	filteredEndpointProviders: readonly [string, number][];
	onEndpointProviderSelect: (provider: string | null) => void;
	onSearchChange: (next: string) => void;
	search: string;
	selectedEndpointProvider: string | null;
}) {
	const t = useTranslations("modelPicker");
	return (
		<>
			<SearchInput
				onChange={onSearchChange}
				placeholder="Search providers"
				value={search}
			/>
			<div className="max-h-56 overflow-y-auto px-2 pb-2">
				<div className="flex flex-col gap-0.5">
					<ProviderRow
						isSelected={selectedEndpointProvider === null}
						label={t("allProviders")}
						onClick={() => onEndpointProviderSelect(null)}
					/>
					{filteredEndpointProviders.length === 0 ? (
						<div className="py-4 text-center text-body-sm text-foreground-muted">
							{t("noProvidersFound")}
						</div>
					) : null}
					{filteredEndpointProviders.map(([provider, count]) => {
						const isSelected = selectedEndpointProvider === provider;
						return (
							<ProviderRow
								count={count}
								isSelected={isSelected}
								key={provider}
								label={formatProviderName(provider)}
								onClick={() =>
									onEndpointProviderSelect(isSelected ? null : provider)
								}
							/>
						);
					})}
				</div>
			</div>
		</>
	);
}

/**
 * The cloud (OpenRouter) picker's sort + filter control. Same drill-down shell
 * as the local pickers, which is the point: five dimensions that used to be a
 * single-open accordion — where opening "Author" collapsed whatever you were
 * reading — are now five peer rows that each get the whole frame.
 */
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
	const t = useTranslations("modelPicker");
	// Search terms live here rather than in the views so drilling out and back
	// in keeps the query — the views are unmounted between visits.
	const [authorSearch, setAuthorSearch] = useState("");
	const [providerSearch, setProviderSearch] = useState("");

	const {
		availableVariants,
		variantCounts,
		endpointProviders,
		providerCounts,
		parameterCounts,
	} = computeModelFiltersMetadata(models);

	// The trigger badge counts filters + the active sort as one combined signal.
	const activeFilterCount =
		computeActiveFilterCount({
			selectedEndpointProvider,
			selectedMakers,
			selectedParameters,
			selectedVariant,
		}) + (sortKey === null ? 0 : 1);

	const sections: FilterNavSection[] = [];
	if (onSortChange) {
		sections.push({
			icon: ArrowUpDownIcon,
			id: "sort",
			label: t("sortBy"),
			render: () => (
				<SortFilterSection onSortChange={onSortChange} sortKey={sortKey} />
			),
			value: sortKey === null ? null : OPENROUTER_SORT_CHIP_LABEL[sortKey],
		});
	}
	sections.push({
		icon: Tag01Icon,
		id: "variant",
		label: t("variant"),
		render: () => (
			<VariantFilterSection
				availableVariants={availableVariants}
				onVariantSelect={onVariantSelect}
				selectedVariant={selectedVariant}
				variantCounts={variantCounts}
			/>
		),
		value: selectedVariant === null ? null : getVariantLabel(selectedVariant),
	});
	if (allProviders.length > 0 && onMakersChange) {
		sections.push({
			badge: selectedMakers.length,
			icon: SparklesIcon,
			id: "author",
			label: "Author",
			render: () => (
				<AuthorFilterSection
					favoriteProviders={favoriteProviders}
					filteredAuthors={filterTextOptions(
						allProviders,
						authorSearch,
						formatMaker,
					)}
					onMakersChange={onMakersChange}
					onSearchChange={setAuthorSearch}
					onToggleFavorite={onToggleFavorite}
					providerCounts={providerCounts}
					search={authorSearch}
					selectedMakers={selectedMakers}
				/>
			),
		});
	}
	sections.push({
		badge: selectedParameters.length,
		icon: Settings01Icon,
		id: "parameters",
		label: t("capabilities"),
		render: () => (
			<ParametersFilterSection
				onParametersChange={onParametersChange}
				parameterCounts={parameterCounts}
				selectedParameters={selectedParameters}
			/>
		),
	});
	if (endpointProviders.length > 0) {
		sections.push({
			icon: ServerStack01Icon,
			id: "provider",
			label: "Endpoint provider",
			render: () => (
				<EndpointProviderFilterSection
					filteredEndpointProviders={filterEndpointProviderEntries(
						endpointProviders,
						providerSearch,
					)}
					onEndpointProviderSelect={onEndpointProviderSelect}
					onSearchChange={setProviderSearch}
					search={providerSearch}
					selectedEndpointProvider={selectedEndpointProvider}
				/>
			),
			value: selectedEndpointProvider
				? formatProviderName(selectedEndpointProvider)
				: null,
		});
	}

	return (
		<FilterNavMenu
			activeFilterCount={activeFilterCount}
			canClear={activeFilterCount > 0}
			clearLabel={t("clearAll")}
			dataSlot="model-filters-menu-content"
			label={t("sortAndFilter")}
			onClearAll={() => {
				onMakersChange?.([]);
				onVariantSelect(null);
				onEndpointProviderSelect(null);
				onParametersChange([]);
				onSortChange?.(null);
			}}
			sections={sections}
			triggerClassName={className}
			widthPx={320}
		/>
	);
}
