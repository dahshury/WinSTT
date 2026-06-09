"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import {
	ArrowDown01Icon,
	ArrowUpDownIcon,
	BookOpen02Icon,
	FilterIcon,
	ServerStack01Icon,
	Settings01Icon,
	SparklesIcon,
	StarIcon,
	Tag01Icon,
	TextFontIcon,
	Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type ComponentPropsWithoutRef, type ReactNode, useState } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { Z_INDEX } from "@/shared/config/z-index";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { FilterMenuTriggerButton } from "../core/FilterMenuTriggerButton";
import { getParameterIcon, getVariantIcon } from "../lib/filter-icons";
import {
	computeActiveFilterCount,
	getActiveFiltersAttr,
} from "../lib/model-filters-menu-utils";
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

type FilterSection = "sort" | "variant" | "author" | "parameters" | "provider";

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

function nextOpenSection(
	current: FilterSection | null,
	next: FilterSection,
): FilterSection | null {
	return current === next ? null : next;
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
	return options.filter((value) => {
		const label = format(value).toLowerCase();
		return (
			label.includes(normalized) || value.toLowerCase().includes(normalized)
		);
	});
}

function filterEndpointProviderEntries(
	providers: readonly [string, number][],
	query: string,
): readonly [string, number][] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) {
		return providers;
	}
	return providers.filter(([provider]) => {
		const label = formatProviderName(provider).toLowerCase();
		return (
			label.includes(normalized) || provider.toLowerCase().includes(normalized)
		);
	});
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

function ActiveFilterHeader({
	count,
	onClearAll,
}: {
	count: number;
	onClearAll: () => void;
}) {
	if (count <= 0) {
		return null;
	}
	return (
		<div className="flex items-center justify-between px-3 py-2">
			<span className="text-foreground-muted text-xs">{count} active</span>
			<BaseButton
				className="font-medium text-accent text-xs hover:underline"
				onClick={onClearAll}
				type="button"
			>
				Clear all
			</BaseButton>
		</div>
	);
}

function FilterAccordionSection({
	children,
	icon,
	isLast,
	isOpen,
	label,
	onToggle,
	valueLabel,
}: {
	children: ReactNode;
	icon: IconSvgElement;
	isLast?: boolean | undefined;
	isOpen: boolean;
	label: string;
	onToggle: () => void;
	valueLabel?: string | null | undefined;
}) {
	return (
		<div className={cn(!isLast && "border-divider/70 border-b")}>
			<BaseButton
				aria-expanded={isOpen}
				className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-2 text-start transition-colors hover:bg-foreground/[0.045]"
				onClick={onToggle}
				type="button"
			>
				<span className="flex min-w-0 items-center gap-2">
					<HugeiconsIcon
						aria-hidden="true"
						className="size-4 shrink-0 text-foreground-muted"
						icon={icon}
					/>
					<span className="truncate font-medium text-body-sm text-foreground">
						{label}
					</span>
				</span>
				<span className="flex shrink-0 items-center gap-2">
					{valueLabel ? (
						<span className="max-w-32 truncate rounded-full bg-accent/15 px-2 py-0.5 font-medium text-[11px] text-accent">
							{valueLabel}
						</span>
					) : null}
					<HugeiconsIcon
						aria-hidden="true"
						className={cn(
							"size-4 text-foreground-muted transition-transform duration-150",
							isOpen && "rotate-180",
						)}
						icon={ArrowDown01Icon}
					/>
				</span>
			</BaseButton>
			{isOpen ? children : null}
		</div>
	);
}

function FilterChip({
	active,
	count,
	label,
	leading,
	onClick,
}: {
	active: boolean;
	count?: number | undefined;
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
				"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium text-[11px] leading-none ring-1 transition-colors",
				active ? "bg-accent/15 text-accent ring-accent/40" : idleChip,
			)}
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
	return (
		<div className="flex flex-col gap-2 px-3 pt-1 pb-3">
			<p className="text-[11px] text-foreground-muted leading-snug">
				Flatten providers into one ordered list. Tap the active option again to
				return to grouped.
			</p>
			<div className="flex flex-wrap gap-1.5">
				{OPENROUTER_SORT_KEYS.map((key) => (
					<FilterChip
						active={sortKey === key}
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
					? "border-accent bg-accent text-white"
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
							isFavorite && "fill-amber-400 text-amber-400",
						)}
						icon={StarIcon}
					/>
				</BaseButton>
			) : null}
		</div>
	);
}

function AuthorFilterSection({
	authorSearch,
	favoriteProviders,
	filteredAuthors,
	onAuthorSearchChange,
	onMakersChange,
	onToggleFavorite,
	providerCounts,
	selectedMakers,
}: {
	authorSearch: string;
	favoriteProviders: string[];
	filteredAuthors: readonly string[];
	onAuthorSearchChange: (next: string) => void;
	onMakersChange: (makers: string[]) => void;
	onToggleFavorite?: ((maker: string) => void) | undefined;
	providerCounts: Map<string, number>;
	selectedMakers: string[];
}) {
	return (
		<>
			<SearchInput
				onChange={onAuthorSearchChange}
				placeholder="Search authors"
				value={authorSearch}
			/>
			<div className="max-h-56 overflow-y-auto px-2 pb-2">
				<div className="flex flex-col gap-0.5">
					{filteredAuthors.length === 0 ? (
						<div className="py-4 text-center text-body-sm text-foreground-muted">
							No authors found.
						</div>
					) : null}
					{filteredAuthors.map((provider) => (
						<AuthorRow
							count={providerCounts.get(provider)}
							isFavorite={favoriteProviders.includes(provider)}
							isSelected={selectedMakers.includes(provider)}
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
			{FILTERABLE_PARAMETERS.map((param) => (
				<FilterChip
					active={selectedParameters.includes(param)}
					count={parameterCounts.get(param)}
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
	onProviderSearchChange,
	providerSearch,
	selectedEndpointProvider,
}: {
	filteredEndpointProviders: readonly [string, number][];
	onEndpointProviderSelect: (provider: string | null) => void;
	onProviderSearchChange: (next: string) => void;
	providerSearch: string;
	selectedEndpointProvider: string | null;
}) {
	return (
		<>
			<SearchInput
				onChange={onProviderSearchChange}
				placeholder="Search providers"
				value={providerSearch}
			/>
			<div className="max-h-56 overflow-y-auto px-2 pb-2">
				<div className="flex flex-col gap-0.5">
					<ProviderRow
						isSelected={selectedEndpointProvider === null}
						label="All providers"
						onClick={() => onEndpointProviderSelect(null)}
					/>
					{filteredEndpointProviders.length === 0 ? (
						<div className="py-4 text-center text-body-sm text-foreground-muted">
							No providers found.
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
	const level = Math.min(useSurface() + 1, 8);
	const [openSection, setOpenSection] = useState<FilterSection | null>(
		onSortChange ? "sort" : "variant",
	);
	const [authorSearch, setAuthorSearch] = useState("");
	const [providerSearch, setProviderSearch] = useState("");

	const metadata = computeModelFiltersMetadata(models);
	const {
		availableVariants,
		variantCounts,
		endpointProviders,
		providerCounts,
		parameterCounts,
	} = metadata;

	// The trigger badge counts filters + the active sort as one combined signal.
	const activeFilterCount =
		computeActiveFilterCount({
			selectedEndpointProvider,
			selectedMakers,
			selectedParameters,
			selectedVariant,
		}) + (sortKey === null ? 0 : 1);
	const filteredAuthors = filterTextOptions(
		allProviders,
		authorSearch,
		formatMaker,
	);
	const filteredEndpointProviders = filterEndpointProviderEntries(
		endpointProviders,
		providerSearch,
	);

	const toggleSection = (section: FilterSection) => {
		setOpenSection((current) => nextOpenSection(current, section));
	};
	const clearAll = () => {
		onMakersChange?.([]);
		onVariantSelect(null);
		onEndpointProviderSelect(null);
		onParametersChange([]);
		onSortChange?.(null);
	};

	return (
		<Popover.Root>
			<Popover.Trigger
				nativeButton
				render={(props) => (
					<FilterMenuTriggerButton
						buttonProps={props as ComponentPropsWithoutRef<"button">}
						className={className}
						count={activeFilterCount}
						label="Sort & filter"
					/>
				)}
			/>
			<Popover.Portal>
				<Popover.Positioner
					align="end"
					sideOffset={6}
					style={{ zIndex: Z_INDEX.popover }}
				>
					<Popover.Popup
						className={cn(
							"select-popup w-[320px] origin-(--transform-origin) overflow-hidden rounded-md border border-border p-1 font-sans text-body text-foreground shadow-md transition-[transform,opacity] duration-150 ease-out data-[ending-style]:ease-in",
							surfaceBg(level),
						)}
						data-active-filters={getActiveFiltersAttr(activeFilterCount)}
						data-slot="model-filters-menu-content"
					>
						<SurfaceProvider value={level}>
							<ActiveFilterHeader
								count={activeFilterCount}
								onClearAll={clearAll}
							/>
							{onSortChange ? (
								<FilterAccordionSection
									icon={ArrowUpDownIcon}
									isOpen={openSection === "sort"}
									label="Sort by"
									onToggle={() => toggleSection("sort")}
									valueLabel={
										sortKey === null
											? null
											: OPENROUTER_SORT_CHIP_LABEL[sortKey]
									}
								>
									<SortFilterSection
										onSortChange={onSortChange}
										sortKey={sortKey}
									/>
								</FilterAccordionSection>
							) : null}
							<FilterAccordionSection
								icon={Tag01Icon}
								isOpen={openSection === "variant"}
								label="Variant"
								onToggle={() => toggleSection("variant")}
								valueLabel={
									selectedVariant === null
										? null
										: getVariantLabel(selectedVariant)
								}
							>
								<VariantFilterSection
									availableVariants={availableVariants}
									onVariantSelect={onVariantSelect}
									selectedVariant={selectedVariant}
									variantCounts={variantCounts}
								/>
							</FilterAccordionSection>
							{allProviders.length > 0 && onMakersChange ? (
								<FilterAccordionSection
									icon={SparklesIcon}
									isOpen={openSection === "author"}
									label="Author"
									onToggle={() => toggleSection("author")}
									valueLabel={
										selectedMakers.length > 0
											? `${selectedMakers.length}`
											: null
									}
								>
									<AuthorFilterSection
										authorSearch={authorSearch}
										favoriteProviders={favoriteProviders}
										filteredAuthors={filteredAuthors}
										onAuthorSearchChange={setAuthorSearch}
										onMakersChange={onMakersChange}
										onToggleFavorite={onToggleFavorite}
										providerCounts={providerCounts}
										selectedMakers={selectedMakers}
									/>
								</FilterAccordionSection>
							) : null}
							<FilterAccordionSection
								icon={Settings01Icon}
								isOpen={openSection === "parameters"}
								label="Capabilities"
								onToggle={() => toggleSection("parameters")}
								valueLabel={
									selectedParameters.length > 0
										? `${selectedParameters.length}`
										: null
								}
							>
								<ParametersFilterSection
									onParametersChange={onParametersChange}
									parameterCounts={parameterCounts}
									selectedParameters={selectedParameters}
								/>
							</FilterAccordionSection>
							{endpointProviders.length > 0 ? (
								<FilterAccordionSection
									icon={ServerStack01Icon}
									isLast
									isOpen={openSection === "provider"}
									label="Endpoint provider"
									onToggle={() => toggleSection("provider")}
									valueLabel={
										selectedEndpointProvider
											? formatProviderName(selectedEndpointProvider)
											: null
									}
								>
									<EndpointProviderFilterSection
										filteredEndpointProviders={filteredEndpointProviders}
										onEndpointProviderSelect={onEndpointProviderSelect}
										onProviderSearchChange={setProviderSearch}
										providerSearch={providerSearch}
										selectedEndpointProvider={selectedEndpointProvider}
									/>
								</FilterAccordionSection>
							) : null}
						</SurfaceProvider>
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover.Root>
	);
}
