"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	ArrowRight01Icon,
	BookOpen02Icon,
	CheckmarkCircle02Icon,
	CpuIcon,
	MessageOutgoing02Icon,
	ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentPropsWithoutRef, memo, type ReactNode } from "react";
import type { ScrollToIndexOpts } from "virtua";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { Collapsible, useOpenedFlag } from "../core/Collapsible";
import { EndpointFeatureIcons } from "../ui/EndpointFeatureIcons";
import { ModelModalityIcons } from "../ui/ModelModalityIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import {
	formatContextLength,
	getPricingTier,
	getUniqueEndpoints,
	getVariantClasses,
	getVariantIcon,
} from "./model-selector-display-utils";
import { formatMaker, formatModelName } from "./model-selector-utils";
import { MODEL_VARIANT_INFO } from "./model-variant-utils";
import { getProviderIconWithFallback } from "./provider-icons";

type ModelVariantKey = NonNullable<OpenRouterModel["variant"]>;

const VARIANT_GRADIENT_MAP: Record<ModelVariantKey, string> = {
	free: "from-emerald-500/40 via-emerald-500/20",
	nitro: "from-amber-500/40 via-amber-500/20",
	thinking: "from-violet-500/40 via-violet-500/20",
	extended: "from-blue-500/40 via-blue-500/20",
	exacto: "from-rose-500/40 via-rose-500/20",
	floor: "from-cyan-500/40 via-cyan-500/20",
	online: "from-sky-500/40 via-sky-500/20",
};

const uniqueEndpointsCache = new WeakMap<OpenRouterModel, OpenRouterEndpoint[]>();
function getCachedUniqueEndpoints(model: OpenRouterModel): OpenRouterEndpoint[] {
	const cached = uniqueEndpointsCache.get(model);
	if (cached) {
		return cached;
	}
	const fresh = getUniqueEndpoints(model.endpoints ?? []);
	uniqueEndpointsCache.set(model, fresh);
	return fresh;
}

function isPositiveNumber(value: number | null | undefined): value is number {
	return value != null && value > 0;
}

function hasModelEndpoints(model: OpenRouterModel): boolean {
	return !!(model.endpoints && model.endpoints.length > 0);
}

function getEndpointProviderSlug(endpoint: OpenRouterEndpoint): string {
	return endpoint.tag || endpoint.provider_name;
}

function findSelectedProvider(
	endpoints: OpenRouterEndpoint[],
	parsedProviderSlug: string | undefined
): OpenRouterEndpoint | null {
	if (!parsedProviderSlug) {
		return null;
	}
	return (
		endpoints.find((e) => e.provider_name === parsedProviderSlug || e.tag === parsedProviderSlug) ??
		null
	);
}

interface ModelHeaderState {
	hasEndpoints: boolean;
	isProviderSelected: boolean;
	isSelected: boolean;
	pricingInfo: ReturnType<typeof getPricingTier> | null;
	selectedProvider: OpenRouterEndpoint | null;
	uniqueEndpoints: OpenRouterEndpoint[];
	variantClasses: ReturnType<typeof getVariantClasses> | null;
}

interface SelectionFlags {
	isProviderSelected: boolean;
	isSelected: boolean;
}

function computeSelectionFlags(
	modelId: string,
	parsedModelId: string | undefined,
	parsedProviderSlug: string | undefined
): SelectionFlags {
	const isModelMatch = parsedModelId === modelId;
	return {
		isSelected: isModelMatch && !parsedProviderSlug,
		isProviderSelected: isModelMatch && !!parsedProviderSlug,
	};
}

function computeModelEndpoints(model: OpenRouterModel): {
	hasEndpoints: boolean;
	uniqueEndpoints: OpenRouterEndpoint[];
} {
	const hasEndpoints = hasModelEndpoints(model);
	const uniqueEndpoints = hasEndpoints ? getCachedUniqueEndpoints(model) : [];
	return { hasEndpoints, uniqueEndpoints };
}

function computeVariantClasses(
	model: OpenRouterModel
): ReturnType<typeof getVariantClasses> | null {
	return model.variant ? getVariantClasses(model.variant) : null;
}

function computeHeaderPricing(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasProviders: boolean
): ReturnType<typeof getPricingTier> | null {
	if (hasProviders) {
		return null;
	}
	const firstEndpoint = uniqueEndpoints[0];
	return firstEndpoint ? getPricingTier(firstEndpoint.pricing) : null;
}

function computeSelectedProvider(
	uniqueEndpoints: OpenRouterEndpoint[],
	flags: SelectionFlags,
	parsedProviderSlug: string | undefined
): OpenRouterEndpoint | null {
	return flags.isProviderSelected
		? findSelectedProvider(uniqueEndpoints, parsedProviderSlug)
		: null;
}

function computeModelHeaderState(
	model: OpenRouterModel,
	parsedModelId: string | undefined,
	parsedProviderSlug: string | undefined,
	hasProviders: boolean
): ModelHeaderState {
	const { hasEndpoints, uniqueEndpoints } = computeModelEndpoints(model);
	const flags = computeSelectionFlags(model.id, parsedModelId, parsedProviderSlug);
	const selectedProvider = computeSelectedProvider(uniqueEndpoints, flags, parsedProviderSlug);
	return {
		hasEndpoints,
		uniqueEndpoints,
		isSelected: flags.isSelected,
		isProviderSelected: flags.isProviderSelected,
		selectedProvider,
		variantClasses: computeVariantClasses(model),
		pricingInfo: computeHeaderPricing(uniqueEndpoints, hasProviders),
	};
}

const MODEL_CARD_BASE_CLASSES = cn(
	"group/card relative flex items-stretch rounded-md border p-0 transition-[color,background-color,border-color,box-shadow] duration-200",
	"border-border bg-surface-secondary/60",
	"hover:border-border-hover hover:bg-surface-hover/60 hover:shadow-md"
);
const MODEL_CARD_SELECTED_CLASSES = "border-accent/50 bg-accent/10 shadow-md ring-1 ring-accent/30";

function isAnyModelSelected(flags: SelectionFlags): boolean {
	return flags.isSelected || flags.isProviderSelected;
}

function getModelCardClassName(flags: SelectionFlags): string {
	return cn(MODEL_CARD_BASE_CLASSES, isAnyModelSelected(flags) && MODEL_CARD_SELECTED_CLASSES);
}

const PROVIDER_CARD_BASE_CLASSES = cn(
	"group/provider relative flex h-full cursor-pointer flex-col gap-1 rounded-md border p-2 transition-[color,background-color,border-color,box-shadow] duration-200",
	"border-border/50 bg-surface-secondary/40",
	"hover:border-border-hover hover:bg-surface-hover/70 hover:shadow-sm"
);
const PROVIDER_CARD_SELECTED_CLASSES = "border-accent/50 bg-accent/10 ring-1 ring-accent/30";

function getProviderCardClassName(isSelected: boolean): string {
	return cn(PROVIDER_CARD_BASE_CLASSES, isSelected && PROVIDER_CARD_SELECTED_CLASSES);
}

const SELECTION_DOT_BASE =
	"absolute end-1.5 top-1.5 size-2 rounded-full transition-[background-color,box-shadow] duration-200";
const SELECTION_DOT_SELECTED = "bg-accent shadow-[0_0_4px_var(--color-accent-glow-strong)]";
const SELECTION_DOT_IDLE = "bg-transparent ring-1 ring-border/50 group-hover/provider:ring-border";

function getSelectionDotClassName(isSelected: boolean): string {
	return cn(SELECTION_DOT_BASE, isSelected ? SELECTION_DOT_SELECTED : SELECTION_DOT_IDLE);
}

function getNonFreeBaseTextColor(withForegroundFallback: boolean): string {
	return withForegroundFallback ? "text-foreground-secondary" : "text-foreground";
}

function getPricingBaseTextColor(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	if (pricingInfo.tier === "free") {
		return "text-emerald-600 dark:text-emerald-400";
	}
	return getNonFreeBaseTextColor(withForegroundFallback);
}

function getPricingExtraClass(pricingInfo: ReturnType<typeof getPricingTier>): string | false {
	return pricingInfo.tier === "free" ? false : pricingInfo.className;
}

function getPricingClassName(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	return cn(
		"flex cursor-default items-center font-semibold text-[11px] tabular-nums",
		getPricingBaseTextColor(pricingInfo, withForegroundFallback),
		getPricingExtraClass(pricingInfo)
	);
}

function getPricingLabel(pricingInfo: ReturnType<typeof getPricingTier>): string {
	return pricingInfo.tier === "free" ? "Free" : pricingInfo.label;
}

function getProvidersRowState(isOpen: boolean): "open" | "closed" {
	return isOpen ? "open" : "closed";
}

function getProvidersGridTemplateRows(isOpen: boolean): string {
	return isOpen ? "1fr" : "0fr";
}

function getExpandAriaLabel(isExpanded: boolean, providerCount: number): string {
	const verb = isExpanded ? "Hide" : "Show";
	return `${verb} ${providerCount} hosting providers`;
}

const EXPAND_BUTTON_BASE = cn(
	"flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 self-stretch border-border border-s font-medium text-[10px] transition-colors duration-150",
	"text-foreground-muted hover:bg-accent/10 hover:text-accent active:bg-accent/15"
);

function getExpandButtonClassName(isExpanded: boolean): string {
	return cn(EXPAND_BUTTON_BASE, isExpanded && "bg-accent/10 text-accent");
}

function getChevronClassName(isExpanded: boolean): string {
	return cn("size-3 transition-transform duration-200", isExpanded && "rotate-90");
}

function getProviderCountTooltip(providerCount: number): string {
	const verb = providerCount === 1 ? " hosts" : "s host";
	return `${providerCount} provider${verb} this model. Tap to compare pricing, latency, and features.`;
}

interface SelectionState {
	kind: "selected" | "provider" | "none";
}

function getSelectionState(isSelected: boolean, isProviderSelected: boolean): SelectionState {
	if (isSelected) {
		return { kind: "selected" };
	}
	if (isProviderSelected) {
		return { kind: "provider" };
	}
	return { kind: "none" };
}

function getSelectionProviderTooltip(selectedProviderName: string | undefined): string {
	return selectedProviderName ? `Provider: ${selectedProviderName}` : "Provider selected";
}

export type VirtualizedItem =
	| {
			type: "model";
			model: OpenRouterModel;
			groupIndex: number;
			index: number;
			isExpanded: boolean;
			hasProviders: boolean;
	  }
	| {
			type: "providers";
			model: OpenRouterModel;
			endpoints: OpenRouterEndpoint[];
			isOpen: boolean;
			index: number;
	  };

export function buildVirtualItems(
	groupedModels: [string, OpenRouterModel[]][],
	expandedModels: Set<string>
): VirtualizedItem[] {
	const items: VirtualizedItem[] = [];
	let globalIndex = 0;
	for (const [groupIndex, [, makerModels]] of groupedModels.entries()) {
		for (const model of makerModels) {
			globalIndex = appendModelEntries(items, globalIndex, model, groupIndex, expandedModels);
		}
	}
	return items;
}

function appendModelEntries(
	items: VirtualizedItem[],
	startIndex: number,
	model: OpenRouterModel,
	groupIndex: number,
	expandedModels: Set<string>
): number {
	const isExpanded = expandedModels.has(model.id);
	const uniqueEndpoints = getCachedUniqueEndpoints(model);
	const hasProviders = uniqueEndpoints.length > 1;
	let nextIndex = startIndex;
	items.push({
		type: "model",
		model,
		groupIndex,
		index: nextIndex,
		isExpanded: isExpanded && hasProviders,
		hasProviders,
	});
	nextIndex += 1;
	if (hasProviders) {
		items.push({
			type: "providers",
			model,
			endpoints: uniqueEndpoints,
			isOpen: isExpanded,
			index: nextIndex,
		});
		nextIndex += 1;
	}
	return nextIndex;
}

interface ItemSizeHandle {
	getItemOffset: (index: number) => number;
	getItemSize: (index: number) => number;
}

function findActiveVirtualIndex(handle: ItemSizeHandle, itemCount: number, offset: number): number {
	const threshold = offset + 1;
	for (let i = 0; i < itemCount; i++) {
		const start = handle.getItemOffset(i);
		const size = handle.getItemSize(i);
		if (start + size > threshold) {
			return i;
		}
	}
	return itemCount - 1;
}

function findIndexByModelId(items: VirtualizedItem[], modelId: string | undefined): number {
	if (!modelId) {
		return -1;
	}
	return items.findIndex((item) => item.type === "model" && item.model.id === modelId);
}

function findIndexByMaker(items: VirtualizedItem[], maker: string): number {
	return items.findIndex((item) => item.type === "model" && item.model.maker === maker);
}

interface ScrollRequest {
	maker: string;
	modelId?: string | undefined;
	nonce: number;
}

function findScrollTargetIndex(items: VirtualizedItem[], request: ScrollRequest): number {
	const byId = findIndexByModelId(items, request.modelId);
	if (byId >= 0) {
		return byId;
	}
	return findIndexByMaker(items, request.maker);
}

function VariantAccentStrip({ variant, gradient }: { variant: ModelVariantKey; gradient: string }) {
	return (
		<div
			className={cn(
				"absolute inset-x-0 top-0 h-1 rounded-t-md bg-gradient-to-r",
				gradient,
				VARIANT_GRADIENT_MAP[variant]
			)}
		/>
	);
}

function ProviderStatChip({
	icon,
	value,
	tooltipTitle,
	tooltipBody,
}: {
	icon: typeof BookOpen02Icon;
	value: number | null | undefined;
	tooltipTitle: string;
	tooltipBody: string;
}) {
	if (!isPositiveNumber(value)) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className="flex min-w-0 cursor-default items-center gap-1"
					>
						<HugeiconsIcon className="size-3 shrink-0 text-foreground-muted" icon={icon} />
						<span className="truncate font-medium text-foreground-secondary">
							{formatContextLength(value)}
						</span>
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">{tooltipTitle}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">{tooltipBody}</p>
			</TooltipContent>
		</Tooltip>
	);
}

function shouldShowStatsRow(
	contextLength: number | null | undefined,
	maxOut: number | null | undefined
): boolean {
	return isPositiveNumber(contextLength) || isPositiveNumber(maxOut);
}

function ProviderStatsRow({
	contextLength,
	maxOut,
}: {
	contextLength: number | null | undefined;
	maxOut: number | null | undefined;
}) {
	if (!shouldShowStatsRow(contextLength, maxOut)) {
		return null;
	}
	return (
		<div className="grid grid-cols-2 gap-x-2 text-[10px] tabular-nums">
			<div className="min-w-0">
				<ProviderStatChip
					icon={BookOpen02Icon}
					tooltipBody="Maximum tokens this provider can read in a single request — prompt plus prior conversation."
					tooltipTitle="Context window"
					value={contextLength}
				/>
			</div>
			<div className="min-w-0">
				<ProviderStatChip
					icon={MessageOutgoing02Icon}
					tooltipBody="Maximum tokens this provider can generate in a single response."
					tooltipTitle="Max output"
					value={maxOut}
				/>
			</div>
		</div>
	);
}

function ProviderPricingTooltip({
	pricingInfo,
}: {
	pricingInfo: ReturnType<typeof getPricingTier>;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className={getPricingClassName(pricingInfo, false)}
					>
						{getPricingLabel(pricingInfo)}
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">Pricing</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					Approximate cost per 1M tokens for this provider (input/output).
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

interface ProviderCardProps {
	endpoint: OpenRouterEndpoint;
	isSelected: boolean;
	model: OpenRouterModel;
	onSelect: (modelId: string | undefined, providerSlug?: string) => void;
	providerSlug: string;
}

const ProviderCard = memo(function ProviderCard({
	model,
	endpoint,
	providerSlug,
	isSelected,
	onSelect,
}: ProviderCardProps) {
	const pricingInfo = getPricingTier(endpoint.pricing);
	const selectProvider = () => onSelect(model.id, providerSlug);
	return (
		<Combobox.Item
			className={getProviderCardClassName(isSelected)}
			onClick={selectProvider}
			value={`${model.id}@${endpoint.provider_name}`}
		>
			<span className={getSelectionDotClassName(isSelected)} />

			<div className="flex min-w-0 items-center gap-1.5 pe-3">
				<HugeiconsIcon className="size-3 shrink-0 text-foreground-muted" icon={CpuIcon} />
				<span className="truncate font-semibold text-[12px] leading-tight tracking-tight">
					{endpoint.provider_name}
				</span>
			</div>

			<ProviderStatsRow
				contextLength={endpoint.context_length}
				maxOut={endpoint.max_completion_tokens}
			/>

			<div className="mt-auto flex items-center justify-between gap-1.5 border-border/50 border-t pt-1">
				<ProviderPricingTooltip pricingInfo={pricingInfo} />
				<EndpointFeatureIcons className="gap-1" endpoint={endpoint} flat maxIcons={4} size="sm" />
			</div>
		</Combobox.Item>
	);
});

interface ProvidersRowProps {
	endpoints: OpenRouterEndpoint[];
	isOpen: boolean;
	model: OpenRouterModel;
	onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
	parsedModelId: string | undefined;
	parsedProviderSlug: string | undefined;
}

function isProviderSelected(
	model: OpenRouterModel,
	providerSlug: string,
	parsedModelId: string | undefined,
	parsedProviderSlug: string | undefined
): boolean {
	return parsedModelId === model.id && parsedProviderSlug === providerSlug;
}

function ProvidersGrid({
	model,
	endpoints,
	parsedModelId,
	parsedProviderSlug,
	onSelectModel,
}: Omit<ProvidersRowProps, "isOpen">) {
	return (
		<div className="ms-6 me-2 mb-1 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
			{endpoints.map((endpoint) => {
				const providerSlug = getEndpointProviderSlug(endpoint);
				const selected = isProviderSelected(model, providerSlug, parsedModelId, parsedProviderSlug);
				return (
					<ProviderCard
						endpoint={endpoint}
						isSelected={selected}
						key={`${model.id}-${providerSlug}`}
						model={model}
						onSelect={onSelectModel}
						providerSlug={providerSlug}
					/>
				);
			})}
		</div>
	);
}

function ProvidersRowInner({
	model,
	endpoints,
	isOpen,
	parsedModelId,
	parsedProviderSlug,
	onSelectModel,
}: ProvidersRowProps) {
	return (
		<Collapsible data-slot="providers-row" isOpen={isOpen}>
			<ProvidersGrid
				endpoints={endpoints}
				model={model}
				onSelectModel={onSelectModel}
				parsedModelId={parsedModelId}
				parsedProviderSlug={parsedProviderSlug}
			/>
		</Collapsible>
	);
}

export const useProvidersOpenedFlag = useOpenedFlag;

const ProvidersRow = memo(function ProvidersRow(props: ProvidersRowProps) {
	return <ProvidersRowInner {...props} />;
});

function SelectedIndicatorBadge() {
	return (
		<div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-foreground">
			<HugeiconsIcon className="size-3.5" icon={CheckmarkCircle02Icon} />
		</div>
	);
}

function ProviderSelectedIndicator({
	selectedProviderName,
}: {
	selectedProviderName: string | undefined;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent"
					>
						<HugeiconsIcon className="size-3.5" icon={ServerStack01Icon} />
					</div>
				)}
			/>
			<TooltipContent>{getSelectionProviderTooltip(selectedProviderName)}</TooltipContent>
		</Tooltip>
	);
}

function IdleSelectionIndicator() {
	return (
		<div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-secondary/50 text-foreground-dim opacity-0 transition-opacity duration-200 group-hover/card:opacity-100">
			<HugeiconsIcon className="size-3.5" icon={CheckmarkCircle02Icon} />
		</div>
	);
}

const SELECTION_INDICATOR_DISPATCH: Record<
	SelectionState["kind"],
	(props: { selectedProviderName: string | undefined }) => ReactNode
> = {
	selected: () => <SelectedIndicatorBadge />,
	provider: ({ selectedProviderName }) => (
		<ProviderSelectedIndicator selectedProviderName={selectedProviderName} />
	),
	none: () => <IdleSelectionIndicator />,
};

function SelectionIndicator({
	isSelected,
	isProviderSelected,
	selectedProviderName,
}: {
	isSelected: boolean;
	isProviderSelected: boolean;
	selectedProviderName: string | undefined;
}) {
	const state = getSelectionState(isSelected, isProviderSelected);
	const renderer = SELECTION_INDICATOR_DISPATCH[state.kind];
	return <>{renderer({ selectedProviderName })}</>;
}

function resolveMakerIconSrc(maker: string | undefined): string | null {
	if (!maker) {
		return null;
	}
	return getProviderIconWithFallback(maker) ?? null;
}

function MakerIcon({ maker }: { maker: string | undefined }) {
	const providerIcon = resolveMakerIconSrc(maker);
	if (!providerIcon) {
		return null;
	}
	return (
		<span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded border border-border/50 bg-surface p-0.5">
			<img
				alt={`${formatMaker(maker)} icon`}
				className="size-full object-contain"
				height={16}
				loading="lazy"
				src={providerIcon}
				width={16}
			/>
		</span>
	);
}

function ContextChip({ contextLength }: { contextLength: number | null | undefined }) {
	if (!isPositiveNumber(contextLength)) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className="flex cursor-default items-center gap-1 text-[11px] text-foreground-muted tabular-nums"
					>
						<HugeiconsIcon className="size-3 opacity-80" icon={BookOpen02Icon} />
						<span className="font-medium">{formatContextLength(contextLength)}</span>
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">Context window</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					Maximum tokens this model can read in a single request: prompt plus prior conversation.
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function PricingChip({ pricingInfo }: { pricingInfo: ReturnType<typeof getPricingTier> | null }) {
	if (!pricingInfo) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className={getPricingClassName(pricingInfo, true)}
					>
						{getPricingLabel(pricingInfo)}
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">Pricing</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					Approximate cost per 1M tokens (input/output). Expand to compare per-provider pricing.
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function FeaturedEndpointChip({ endpoint }: { endpoint: OpenRouterEndpoint | null }) {
	if (!endpoint) {
		return null;
	}
	return (
		<div className="flex items-center">
			<EndpointFeatureIcons className="gap-1" endpoint={endpoint} flat maxIcons={4} size="sm" />
		</div>
	);
}

function isFeaturedEndpointEligible(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasEndpoints: boolean,
	hasProviders: boolean
): boolean {
	if (hasProviders) {
		return false;
	}
	return hasEndpoints && uniqueEndpoints.length > 0;
}

function getFeaturedEndpoint(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasEndpoints: boolean,
	hasProviders: boolean
): OpenRouterEndpoint | null {
	if (!isFeaturedEndpointEligible(uniqueEndpoints, hasEndpoints, hasProviders)) {
		return null;
	}
	return uniqueEndpoints[0] ?? null;
}

function shouldRenderInlineMeta(
	contextLength: number | null | undefined,
	pricingInfo: ReturnType<typeof getPricingTier> | null,
	featuredEndpoint: OpenRouterEndpoint | null,
	modalities?: readonly string[] | undefined
): boolean {
	return (
		isPositiveNumber(contextLength) ||
		!!pricingInfo ||
		!!featuredEndpoint ||
		(modalities?.length ?? 0) > 0
	);
}

function ModalitiesChip({ modalities }: { modalities: readonly string[] | undefined }) {
	if (!modalities || modalities.length === 0) {
		return null;
	}
	return (
		<div className="flex items-center">
			<ModelModalityIcons className="gap-1" flat maxIcons={4} modalities={modalities} size="sm" />
		</div>
	);
}

function InlineModelMeta({
	model,
	pricingInfo,
	hasProviders,
	uniqueEndpoints,
	hasEndpoints,
}: {
	model: OpenRouterModel;
	pricingInfo: ReturnType<typeof getPricingTier> | null;
	hasProviders: boolean;
	uniqueEndpoints: OpenRouterEndpoint[];
	hasEndpoints: boolean;
}) {
	const featuredEndpoint = getFeaturedEndpoint(uniqueEndpoints, hasEndpoints, hasProviders);
	const modalities = model.architecture?.input_modalities;
	if (!shouldRenderInlineMeta(model.context_length, pricingInfo, featuredEndpoint, modalities)) {
		return null;
	}

	return (
		<div
			className={cn(
				"inline-flex shrink-0 items-stretch overflow-hidden rounded-md border border-border bg-surface-secondary/40",
				"divide-x divide-border [&>*]:px-1.5"
			)}
			data-slot="inline-model-meta"
		>
			<ContextChip contextLength={model.context_length} />
			<PricingChip pricingInfo={pricingInfo} />
			<FeaturedEndpointChip endpoint={featuredEndpoint} />
			<ModalitiesChip modalities={modalities} />
		</div>
	);
}

function VariantBadge({
	variant,
	variantClasses,
}: {
	variant: OpenRouterModel["variant"];
	variantClasses: ReturnType<typeof getVariantClasses> | null;
}) {
	if (!(variant && variantClasses)) {
		return null;
	}
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-0.5 rounded-md border px-1.5 py-0.5 font-semibold text-[10px] uppercase tracking-wide",
				variantClasses.bg,
				variantClasses.text,
				variantClasses.border
			)}
		>
			{getVariantIcon(variant, "size-2.5")}
			{MODEL_VARIANT_INFO[variant]?.label}
		</span>
	);
}

function ModelDescription({ description }: { description: string | undefined }) {
	if (!description) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<p
						{...(props as ComponentPropsWithoutRef<"p">)}
						className="line-clamp-2 cursor-default ps-[22px] text-[11px] text-foreground-muted leading-snug"
					>
						{description}
					</p>
				)}
			/>
			<TooltipContent
				className="!max-w-[min(32rem,calc(100vw-2rem))] max-h-[60vh] overflow-y-auto"
				side="bottom"
			>
				<p className="whitespace-pre-wrap break-words text-xs-tight leading-relaxed">
					{description}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function ProvidersExpandButton({
	modelId,
	isExpanded,
	providerCount,
	onToggleExpanded,
}: {
	modelId: string;
	isExpanded: boolean;
	providerCount: number;
	onToggleExpanded: (modelId: string, nextOpen?: boolean) => void;
}) {
	const toggleProvidersList = (event: React.MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
		onToggleExpanded(modelId, !isExpanded);
	};
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<button
						{...(props as ComponentPropsWithoutRef<"button">)}
						aria-expanded={isExpanded}
						aria-label={getExpandAriaLabel(isExpanded, providerCount)}
						className={getExpandButtonClassName(isExpanded)}
						onClick={toggleProvidersList}
						type="button"
					>
						<HugeiconsIcon className="size-3.5" icon={ServerStack01Icon} />
						<span className="tabular-nums">{providerCount}</span>
						<HugeiconsIcon className={getChevronClassName(isExpanded)} icon={ArrowRight01Icon} />
					</button>
				)}
			/>
			<TooltipContent className="max-w-xs" side="left">
				<p className="font-semibold text-body-sm">Hosting providers</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{getProviderCountTooltip(providerCount)}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function ModelHeaderTitleRow({
	model,
	variantClasses,
}: {
	model: OpenRouterModel;
	variantClasses: ReturnType<typeof getVariantClasses> | null;
}) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-1.5">
			<MakerIcon maker={model.maker} />
			<h3 className="truncate font-semibold text-body-sm leading-tight tracking-tight">
				{formatModelName(model.model_name ?? model.name, model.maker)}
			</h3>
			<VariantBadge variant={model.variant} variantClasses={variantClasses} />
		</div>
	);
}

function ModelHeaderTrailing({
	model,
	state,
	hasProviders,
}: {
	model: OpenRouterModel;
	state: ModelHeaderState;
	hasProviders: boolean;
}) {
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			<InlineModelMeta
				hasEndpoints={state.hasEndpoints}
				hasProviders={hasProviders}
				model={model}
				pricingInfo={state.pricingInfo}
				uniqueEndpoints={state.uniqueEndpoints}
			/>
			<SelectionIndicator
				isProviderSelected={state.isProviderSelected}
				isSelected={state.isSelected}
				selectedProviderName={state.selectedProvider?.provider_name}
			/>
		</div>
	);
}

interface ModelHeaderProps {
	hasProviders: boolean;
	isExpanded: boolean;
	model: OpenRouterModel;
	onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
	onToggleExpanded: (modelId: string, nextOpen?: boolean) => void;
	parsedModelId: string | undefined;
	parsedProviderSlug: string | undefined;
}

function ModelVariantStrip({
	variant,
	variantClasses,
}: {
	variant: OpenRouterModel["variant"];
	variantClasses: ReturnType<typeof getVariantClasses> | null;
}) {
	if (!(variant && variantClasses)) {
		return null;
	}
	return <VariantAccentStrip gradient={variantClasses.gradient} variant={variant} />;
}

function ModelHeaderProvidersButton({
	hasProviders,
	isExpanded,
	modelId,
	providerCount,
	onToggleExpanded,
}: {
	hasProviders: boolean;
	isExpanded: boolean;
	modelId: string;
	providerCount: number;
	onToggleExpanded: (modelId: string, nextOpen?: boolean) => void;
}) {
	if (!hasProviders) {
		return null;
	}
	return (
		<ProvidersExpandButton
			isExpanded={isExpanded}
			modelId={modelId}
			onToggleExpanded={onToggleExpanded}
			providerCount={providerCount}
		/>
	);
}

function ModelHeader({
	model,
	isExpanded,
	hasProviders,
	parsedModelId,
	parsedProviderSlug,
	onToggleExpanded,
	onSelectModel,
}: ModelHeaderProps) {
	const state = computeModelHeaderState(model, parsedModelId, parsedProviderSlug, hasProviders);
	const selectModel = () => onSelectModel(model.id);
	return (
		<div className="mx-2 my-1">
			<Combobox.Item
				className={getModelCardClassName(state)}
				onClick={selectModel}
				value={model.id}
			>
				<ModelVariantStrip variant={model.variant} variantClasses={state.variantClasses} />
				<div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5">
					<div className="flex items-center justify-between gap-2.5">
						<ModelHeaderTitleRow model={model} variantClasses={state.variantClasses} />
						<ModelHeaderTrailing hasProviders={hasProviders} model={model} state={state} />
					</div>
					<ModelDescription description={model.description} />
				</div>
				<ModelHeaderProvidersButton
					hasProviders={hasProviders}
					isExpanded={isExpanded}
					modelId={model.id}
					onToggleExpanded={onToggleExpanded}
					providerCount={state.uniqueEndpoints.length}
				/>
			</Combobox.Item>
		</div>
	);
}

export function VirtualizedRow({
	item,
	parsedModelId,
	parsedProviderSlug,
	onToggleModelExpanded,
	onSelectModel,
}: {
	item: VirtualizedItem;
	parsedModelId: string | undefined;
	parsedProviderSlug: string | undefined;
	onToggleModelExpanded: (modelId: string, nextOpen?: boolean) => void;
	onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
}) {
	if (item.type === "model") {
		return (
			<div key={`model-${item.model.id}`}>
				<ModelHeader
					hasProviders={item.hasProviders}
					isExpanded={item.isExpanded}
					model={item.model}
					onSelectModel={onSelectModel}
					onToggleExpanded={onToggleModelExpanded}
					parsedModelId={parsedModelId}
					parsedProviderSlug={parsedProviderSlug}
				/>
			</div>
		);
	}
	return (
		<div key={`providers-${item.model.id}`}>
			<ProvidersRow
				endpoints={item.endpoints}
				isOpen={item.isOpen}
				model={item.model}
				onSelectModel={onSelectModel}
				parsedModelId={parsedModelId}
				parsedProviderSlug={parsedProviderSlug}
			/>
		</div>
	);
}

export function getRowKey(item: VirtualizedItem): string {
	const prefix = item.type === "model" ? "model" : "providers";
	return `${prefix}-${item.model.id}`;
}

function resolveActiveMaker(items: VirtualizedItem[], idx: number): string | null {
	return items[idx]?.model.maker ?? null;
}

function shouldNotifyMaker(nextMaker: string | null, lastMaker: string | null): boolean {
	return nextMaker !== lastMaker;
}

function isNewScrollNonce(lastNonce: number | null, nonce: number): boolean {
	return lastNonce !== nonce;
}

export function applyVirtualScrollMakerUpdate(
	handle: { getItemOffset: (i: number) => number; getItemSize: (i: number) => number } | null,
	virtualItems: VirtualizedItem[],
	offset: number,
	lastNotifiedMaker: string | null,
	onActiveMakerChange: ((maker: string | null) => void) | undefined
): string | null {
	if (!handle || virtualItems.length === 0) {
		return lastNotifiedMaker;
	}
	const activeIdx = findActiveVirtualIndex(handle, virtualItems.length, offset);
	const nextMaker = resolveActiveMaker(virtualItems, activeIdx);
	if (shouldNotifyMaker(nextMaker, lastNotifiedMaker)) {
		onActiveMakerChange?.(nextMaker);
		return nextMaker;
	}
	return lastNotifiedMaker;
}

export function applyScrollToMakerRequest(
	scrollToMakerRequest: ScrollRequest | null | undefined,
	lastNonce: number | null,
	virtualItems: VirtualizedItem[],
	scrollToIndex: ((index: number, opts?: ScrollToIndexOpts) => void) | undefined
): number | null {
	if (!scrollToMakerRequest) {
		return lastNonce;
	}
	if (!isNewScrollNonce(lastNonce, scrollToMakerRequest.nonce)) {
		return lastNonce;
	}
	const targetIndex = findScrollTargetIndex(virtualItems, scrollToMakerRequest);
	if (targetIndex >= 0) {
		scrollToIndex?.(targetIndex, { align: "start" } satisfies ScrollToIndexOpts);
	}
	return scrollToMakerRequest.nonce;
}

function getEmptyStateLabel(hasActiveFilters: boolean): string {
	return hasActiveFilters ? "No models found" : "Unable to load models";
}

function getEmptyStateBody(hasActiveFilters: boolean): string {
	return hasActiveFilters
		? "Try adjusting your filters to see more results."
		: "The OpenRouter servers may be down or you may have lost internet connection. Please check your connection and try again.";
}

export function EmptyState({ hasActiveFilters }: { hasActiveFilters: boolean }): ReactNode {
	return (
		<div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 text-center">
			<div className="flex size-10 items-center justify-center rounded-full bg-surface-secondary">
				<HugeiconsIcon className="size-5 text-foreground-muted" icon={ServerStack01Icon} />
			</div>
			<p className="text-balance font-semibold text-body">{getEmptyStateLabel(hasActiveFilters)}</p>
			<p className="text-balance text-foreground-muted text-xs-tight">
				{getEmptyStateBody(hasActiveFilters)}
			</p>
		</div>
	);
}

export const __model_list_content_virtualized_test_helpers__ = {
	getCachedUniqueEndpoints,
	isPositiveNumber,
	hasModelEndpoints,
	getEndpointProviderSlug,
	findSelectedProvider,
	computeSelectionFlags,
	computeModelEndpoints,
	computeVariantClasses,
	computeHeaderPricing,
	computeSelectedProvider,
	computeModelHeaderState,
	isAnyModelSelected,
	getModelCardClassName,
	getProviderCardClassName,
	getSelectionDotClassName,
	getNonFreeBaseTextColor,
	getPricingBaseTextColor,
	getPricingExtraClass,
	getPricingClassName,
	getPricingLabel,
	getProvidersRowState,
	getProvidersGridTemplateRows,
	getExpandAriaLabel,
	getExpandButtonClassName,
	getChevronClassName,
	getProviderCountTooltip,
	getSelectionState,
	getSelectionProviderTooltip,
	buildVirtualItems,
	appendModelEntries,
	findActiveVirtualIndex,
	findIndexByModelId,
	findIndexByMaker,
	findScrollTargetIndex,
	getFeaturedEndpoint,
	isFeaturedEndpointEligible,
	shouldRenderInlineMeta,
	shouldShowStatsRow,
	isProviderSelected,
	resolveMakerIconSrc,
	getEmptyStateLabel,
	getEmptyStateBody,
	getRowKey,
	resolveActiveMaker,
	shouldNotifyMaker,
	isNewScrollNonce,
	applyVirtualScrollMakerUpdate,
	applyScrollToMakerRequest,
	VariantBadge,
	ModelVariantStrip,
	VirtualizedRow,
	ProviderStatChip,
	ProviderStatsRow,
	MakerIcon,
	ContextChip,
	PricingChip,
	FeaturedEndpointChip,
	InlineModelMeta,
	ModelDescription,
	ModelHeaderTitleRow,
	ModelHeaderProvidersButton,
};
