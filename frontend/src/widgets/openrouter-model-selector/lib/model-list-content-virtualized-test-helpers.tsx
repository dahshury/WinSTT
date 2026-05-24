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
import { type ComponentPropsWithoutRef, memo, type ReactNode, useState } from "react";
import type { ScrollToIndexOpts } from "virtua";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { EndpointFeatureIcons } from "../ui/EndpointFeatureIcons";
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

/* ── Pure helpers (module scope) ──────────────────────────────────── */

const uniqueEndpointsCache = new WeakMap<OpenRouterModel, OpenRouterEndpoint[]>();
export function getCachedUniqueEndpoints(model: OpenRouterModel): OpenRouterEndpoint[] {
	const cached = uniqueEndpointsCache.get(model);
	if (cached) {
		return cached;
	}
	const fresh = getUniqueEndpoints(model.endpoints ?? []);
	uniqueEndpointsCache.set(model, fresh);
	return fresh;
}

export function isPositiveNumber(value: number | null | undefined): value is number {
	return value != null && value > 0;
}

export function hasModelEndpoints(model: OpenRouterModel): boolean {
	return !!(model.endpoints && model.endpoints.length > 0);
}

export function getEndpointProviderSlug(endpoint: OpenRouterEndpoint): string {
	return endpoint.tag || endpoint.provider_name;
}

export function findSelectedProvider(
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

export function computeSelectionFlags(
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

export function computeModelEndpoints(model: OpenRouterModel): {
	hasEndpoints: boolean;
	uniqueEndpoints: OpenRouterEndpoint[];
} {
	const hasEndpoints = hasModelEndpoints(model);
	const uniqueEndpoints = hasEndpoints ? getCachedUniqueEndpoints(model) : [];
	return { hasEndpoints, uniqueEndpoints };
}

export function computeVariantClasses(
	model: OpenRouterModel
): ReturnType<typeof getVariantClasses> | null {
	return model.variant ? getVariantClasses(model.variant) : null;
}

export function computeHeaderPricing(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasProviders: boolean
): ReturnType<typeof getPricingTier> | null {
	if (hasProviders) {
		return null;
	}
	const firstEndpoint = uniqueEndpoints[0];
	return firstEndpoint ? getPricingTier(firstEndpoint.pricing) : null;
}

export function computeSelectedProvider(
	uniqueEndpoints: OpenRouterEndpoint[],
	flags: SelectionFlags,
	parsedProviderSlug: string | undefined
): OpenRouterEndpoint | null {
	return flags.isProviderSelected
		? findSelectedProvider(uniqueEndpoints, parsedProviderSlug)
		: null;
}

export function computeModelHeaderState(
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

export function isAnyModelSelected(flags: SelectionFlags): boolean {
	return flags.isSelected || flags.isProviderSelected;
}

export function getModelCardClassName(flags: SelectionFlags): string {
	return cn(MODEL_CARD_BASE_CLASSES, isAnyModelSelected(flags) && MODEL_CARD_SELECTED_CLASSES);
}

const PROVIDER_CARD_BASE_CLASSES = cn(
	"group/provider relative flex h-full cursor-pointer flex-col gap-1 rounded-md border p-2 transition-[color,background-color,border-color,box-shadow] duration-200",
	"border-border/50 bg-surface-secondary/40",
	"hover:border-border-hover hover:bg-surface-hover/70 hover:shadow-sm"
);
const PROVIDER_CARD_SELECTED_CLASSES = "border-accent/50 bg-accent/10 ring-1 ring-accent/30";

export function getProviderCardClassName(isSelected: boolean): string {
	return cn(PROVIDER_CARD_BASE_CLASSES, isSelected && PROVIDER_CARD_SELECTED_CLASSES);
}

const SELECTION_DOT_BASE =
	"absolute end-1.5 top-1.5 size-2 rounded-full transition-[background-color,box-shadow] duration-200";
const SELECTION_DOT_SELECTED = "bg-accent shadow-[0_0_4px_var(--color-accent-glow-strong)]";
const SELECTION_DOT_IDLE = "bg-transparent ring-1 ring-border/50 group-hover/provider:ring-border";

export function getSelectionDotClassName(isSelected: boolean): string {
	return cn(SELECTION_DOT_BASE, isSelected ? SELECTION_DOT_SELECTED : SELECTION_DOT_IDLE);
}

export function getNonFreeBaseTextColor(withForegroundFallback: boolean): string {
	return withForegroundFallback ? "text-foreground-secondary" : "text-foreground";
}

export function getPricingBaseTextColor(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	if (pricingInfo.tier === "free") {
		return "text-emerald-600 dark:text-emerald-400";
	}
	return getNonFreeBaseTextColor(withForegroundFallback);
}

export function getPricingExtraClass(
	pricingInfo: ReturnType<typeof getPricingTier>
): string | false {
	return pricingInfo.tier === "free" ? false : pricingInfo.className;
}

export function getPricingClassName(
	pricingInfo: ReturnType<typeof getPricingTier>,
	withForegroundFallback: boolean
): string {
	return cn(
		"flex cursor-default items-center font-semibold text-[11px] tabular-nums",
		getPricingBaseTextColor(pricingInfo, withForegroundFallback),
		getPricingExtraClass(pricingInfo)
	);
}

export function getPricingLabel(pricingInfo: ReturnType<typeof getPricingTier>): string {
	return pricingInfo.tier === "free" ? "Free" : pricingInfo.label;
}

export function getProvidersRowState(isOpen: boolean): "open" | "closed" {
	return isOpen ? "open" : "closed";
}

export function getProvidersGridTemplateRows(isOpen: boolean): string {
	return isOpen ? "1fr" : "0fr";
}

export function getExpandAriaLabel(isExpanded: boolean, providerCount: number): string {
	const verb = isExpanded ? "Hide" : "Show";
	return `${verb} ${providerCount} hosting providers`;
}

const EXPAND_BUTTON_BASE = cn(
	"flex w-11 shrink-0 flex-col items-center justify-center gap-0.5 self-stretch border-border border-s font-medium text-[10px] transition-colors duration-150",
	"text-foreground-muted hover:bg-accent/10 hover:text-accent active:bg-accent/15"
);

export function getExpandButtonClassName(isExpanded: boolean): string {
	return cn(EXPAND_BUTTON_BASE, isExpanded && "bg-accent/10 text-accent");
}

export function getChevronClassName(isExpanded: boolean): string {
	return cn("size-3 transition-transform duration-200", isExpanded && "rotate-90");
}

export function getProviderCountTooltip(providerCount: number): string {
	const verb = providerCount === 1 ? " hosts" : "s host";
	return `${providerCount} provider${verb} this model. Tap to compare pricing, latency, and features.`;
}

interface SelectionState {
	kind: "selected" | "provider" | "none";
}

export function getSelectionState(
	isSelected: boolean,
	isProviderSelected: boolean
): SelectionState {
	if (isSelected) {
		return { kind: "selected" };
	}
	if (isProviderSelected) {
		return { kind: "provider" };
	}
	return { kind: "none" };
}

export function getSelectionProviderTooltip(selectedProviderName: string | undefined): string {
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

export function appendModelEntries(
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

export function findActiveVirtualIndex(
	handle: ItemSizeHandle,
	itemCount: number,
	offset: number
): number {
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

export function findIndexByModelId(items: VirtualizedItem[], modelId: string | undefined): number {
	if (!modelId) {
		return -1;
	}
	return items.findIndex((item) => item.type === "model" && item.model.id === modelId);
}

export function findIndexByMaker(items: VirtualizedItem[], maker: string): number {
	return items.findIndex((item) => item.type === "model" && item.model.maker === maker);
}

interface ScrollRequest {
	maker: string;
	modelId?: string | undefined;
	nonce: number;
}

export function findScrollTargetIndex(items: VirtualizedItem[], request: ScrollRequest): number {
	const byId = findIndexByModelId(items, request.modelId);
	if (byId >= 0) {
		return byId;
	}
	return findIndexByMaker(items, request.maker);
}

/* ── Sub-components ──────────────────────────────────────────────── */

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

export function ProviderStatChip({
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

export function shouldShowStatsRow(
	contextLength: number | null | undefined,
	maxOut: number | null | undefined
): boolean {
	return isPositiveNumber(contextLength) || isPositiveNumber(maxOut);
}

export function ProviderStatsRow({
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

export function isProviderSelected(
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
	hasOpened,
	model,
	endpoints,
	isOpen,
	parsedModelId,
	parsedProviderSlug,
	onSelectModel,
}: ProvidersRowProps & { hasOpened: boolean }) {
	return (
		<div
			className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
			data-slot="providers-row"
			data-state={getProvidersRowState(isOpen)}
			inert={!isOpen}
			style={{ gridTemplateRows: getProvidersGridTemplateRows(isOpen) }}
		>
			<div className="min-h-0 overflow-hidden">
				<ProvidersGridGate
					endpoints={endpoints}
					hasOpened={hasOpened}
					model={model}
					onSelectModel={onSelectModel}
					parsedModelId={parsedModelId}
					parsedProviderSlug={parsedProviderSlug}
				/>
			</div>
		</div>
	);
}

function ProvidersGridGate({
	hasOpened,
	...rest
}: Omit<ProvidersRowProps, "isOpen"> & { hasOpened: boolean }) {
	if (!hasOpened) {
		return null;
	}
	return <ProvidersGrid {...rest} />;
}

export function useProvidersOpenedFlag(isOpen: boolean): boolean {
	const [hasOpened, setHasOpened] = useState(isOpen);
	if (isOpen && !hasOpened) {
		setHasOpened(true);
	}
	return hasOpened;
}

export const ProvidersRow = memo(function ProvidersRow(props: ProvidersRowProps) {
	const hasOpened = useProvidersOpenedFlag(props.isOpen);
	return <ProvidersRowInner hasOpened={hasOpened} {...props} />;
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

export function resolveMakerIconSrc(maker: string | undefined): string | null {
	if (!maker) {
		return null;
	}
	return getProviderIconWithFallback(maker) ?? null;
}

export function MakerIcon({ maker }: { maker: string | undefined }) {
	const providerIcon = resolveMakerIconSrc(maker);
	if (!providerIcon) {
		return null;
	}
	return (
		<span className="flex size-4 shrink-0 items-center justify-center overflow-hidden rounded border border-border/50 bg-surface p-0.5">
			{/** biome-ignore lint/performance/noImgElement: Provider icons are static local PNG/SVGs served from /public; Vite serves them verbatim from public/ and the renderer loads them via plain <img>. */}
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

export function ContextChip({ contextLength }: { contextLength: number | null | undefined }) {
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

export function PricingChip({
	pricingInfo,
}: {
	pricingInfo: ReturnType<typeof getPricingTier> | null;
}) {
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

export function FeaturedEndpointChip({ endpoint }: { endpoint: OpenRouterEndpoint | null }) {
	if (!endpoint) {
		return null;
	}
	return (
		<div className="flex items-center">
			<EndpointFeatureIcons className="gap-1" endpoint={endpoint} flat maxIcons={4} size="sm" />
		</div>
	);
}

export function isFeaturedEndpointEligible(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasEndpoints: boolean,
	hasProviders: boolean
): boolean {
	if (hasProviders) {
		return false;
	}
	return hasEndpoints && uniqueEndpoints.length > 0;
}

export function getFeaturedEndpoint(
	uniqueEndpoints: OpenRouterEndpoint[],
	hasEndpoints: boolean,
	hasProviders: boolean
): OpenRouterEndpoint | null {
	if (!isFeaturedEndpointEligible(uniqueEndpoints, hasEndpoints, hasProviders)) {
		return null;
	}
	return uniqueEndpoints[0] ?? null;
}

export function shouldRenderInlineMeta(
	contextLength: number | null | undefined,
	pricingInfo: ReturnType<typeof getPricingTier> | null,
	featuredEndpoint: OpenRouterEndpoint | null
): boolean {
	return isPositiveNumber(contextLength) || !!pricingInfo || !!featuredEndpoint;
}

export function InlineModelMeta({
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
	if (!shouldRenderInlineMeta(model.context_length, pricingInfo, featuredEndpoint)) {
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
		</div>
	);
}

export function VariantBadge({
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

export function ModelDescription({ description }: { description: string | undefined }) {
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

export function ModelHeaderTitleRow({
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
				{formatModelName(model.model_name ?? model.name)}
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

export function ModelVariantStrip({
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

export function ModelHeaderProvidersButton({
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

export function ModelHeader({
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

/** Pure: resolves the active maker at a given virtual index. */
export function resolveActiveMaker(items: VirtualizedItem[], idx: number): string | null {
	return items[idx]?.model.maker ?? null;
}

/** Pure: determines whether the maker change notification should fire. */
export function shouldNotifyMaker(nextMaker: string | null, lastMaker: string | null): boolean {
	return nextMaker !== lastMaker;
}

/** Pure: determines whether a scroll nonce should be processed. */
export function isNewScrollNonce(lastNonce: number | null, nonce: number): boolean {
	return lastNonce !== nonce;
}

/** Resolves the next active maker for a non-empty virtualized list. */
function resolveNextActiveMaker(
	handle: { getItemOffset: (i: number) => number; getItemSize: (i: number) => number },
	virtualItems: VirtualizedItem[],
	offset: number
): string | null {
	const activeIdx = findActiveVirtualIndex(handle, virtualItems.length, offset);
	return resolveActiveMaker(virtualItems, activeIdx);
}

/** Notifies the listener iff the maker changed, returning the new tracked value. */
function notifyMakerIfChanged(
	nextMaker: string | null,
	lastNotifiedMaker: string | null,
	onActiveMakerChange: ((maker: string | null) => void) | undefined
): string | null {
	if (shouldNotifyMaker(nextMaker, lastNotifiedMaker)) {
		onActiveMakerChange?.(nextMaker);
		return nextMaker;
	}
	return lastNotifiedMaker;
}

/**
 * Pure: applies a virtual-scroll offset to the active-maker tracking state.
 * Returns the next maker string, or null when the list is empty / no change
 * needed. The caller owns the refs and side-effects; this function is pure so
 * it can be unit-tested without a DOM.
 */
export function applyVirtualScrollMakerUpdate(
	handle: { getItemOffset: (i: number) => number; getItemSize: (i: number) => number } | null,
	virtualItems: VirtualizedItem[],
	offset: number,
	lastNotifiedMaker: string | null,
	onActiveMakerChange: ((maker: string | null) => void) | undefined
): string | null {
	if (!handle) {
		return lastNotifiedMaker;
	}
	if (virtualItems.length === 0) {
		return lastNotifiedMaker;
	}
	const nextMaker = resolveNextActiveMaker(handle, virtualItems, offset);
	return notifyMakerIfChanged(nextMaker, lastNotifiedMaker, onActiveMakerChange);
}

/**
 * Resolves the scroll target and invokes the scroll callback when valid.
 * Returns the new nonce that should be tracked by the caller.
 */
function performScrollToMaker(
	scrollToMakerRequest: ScrollRequest,
	virtualItems: VirtualizedItem[],
	scrollToIndex: ((index: number, opts?: ScrollToIndexOpts) => void) | undefined
): number {
	const targetIndex = findScrollTargetIndex(virtualItems, scrollToMakerRequest);
	if (targetIndex >= 0) {
		scrollToIndex?.(targetIndex, { align: "start" } satisfies ScrollToIndexOpts);
	}
	return scrollToMakerRequest.nonce;
}

/**
 * Pure: applies a scroll-to-maker request, performing the scroll when the
 * nonce is new. Returns true when the scroll was performed, false otherwise.
 */
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
	return performScrollToMaker(scrollToMakerRequest, virtualItems, scrollToIndex);
}

export function getEmptyStateLabel(hasActiveFilters: boolean): string {
	return hasActiveFilters ? "No models found" : "Unable to load models";
}

export function getEmptyStateBody(hasActiveFilters: boolean): string {
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
	// Component exports for isolated rendering tests
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
