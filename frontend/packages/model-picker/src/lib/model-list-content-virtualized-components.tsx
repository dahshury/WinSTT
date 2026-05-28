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
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, useSurface } from "@/shared/lib/surface";
import { Collapsible } from "../core/Collapsible";
import { EndpointFeatureIcons } from "../ui/EndpointFeatureIcons";
import { ModelModalityIcons } from "../ui/ModelModalityIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import {
	computeModelHeaderState,
	getChevronClassName,
	getEmptyStateBody,
	getEmptyStateLabel,
	getEndpointProviderSlug,
	getExpandAriaLabel,
	getExpandButtonClassName,
	getFeaturedEndpoint,
	getModelCardClassName,
	getPricingClassName,
	getPricingLabel,
	getProviderCardClassName,
	getProviderCountTooltip,
	getSelectionDotClassName,
	getSelectionProviderTooltip,
	getSelectionState,
	isPositiveNumber,
	isProviderSelected,
	type ModelHeaderState,
	type ModelVariantKey,
	resolveMakerIconSrc,
	type SelectionState,
	shouldRenderInlineMeta,
	shouldShowStatsRow,
	VARIANT_GRADIENT_MAP,
	type VirtualizedItem,
} from "./model-list-content-virtualized-utils";
import {
	formatContextLength,
	getPricingTier,
	type getVariantClasses,
	getVariantIcon,
} from "./model-selector-display-utils";
import { formatMaker, formatModelName } from "./model-selector-utils";
import { MODEL_VARIANT_INFO } from "./model-variant-utils";

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

function ProviderCard({ model, endpoint, providerSlug, isSelected, onSelect }: ProviderCardProps) {
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
}

interface ProvidersRowProps {
	endpoints: OpenRouterEndpoint[];
	isOpen: boolean;
	model: OpenRouterModel;
	onSelectModel: (modelId: string | undefined, providerSlug?: string) => void;
	parsedModelId: string | undefined;
	parsedProviderSlug: string | undefined;
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

function ProvidersRow({
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
	isProviderSelected: isProviderSel,
	selectedProviderName,
}: {
	isSelected: boolean;
	isProviderSelected: boolean;
	selectedProviderName: string | undefined;
}) {
	const state = getSelectionState(isSelected, isProviderSel);
	const renderer = SELECTION_INDICATOR_DISPATCH[state.kind];
	return <>{renderer({ selectedProviderName })}</>;
}

export function MakerIcon({ maker }: { maker: string | undefined }) {
	const level = Math.min(useSurface() + 1, 8);
	const providerIcon = resolveMakerIconSrc(maker);
	if (!providerIcon) {
		return null;
	}
	return (
		<span
			className={cn(
				"flex size-4 shrink-0 items-center justify-center overflow-hidden rounded border border-border/50 p-0.5",
				surfaceBg(level)
			)}
		>
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

export function EmptyState({ hasActiveFilters }: { hasActiveFilters: boolean }): ReactNode {
	const level = Math.min(useSurface() + 1, 8);
	return (
		<div className="mx-auto flex w-full max-w-[280px] flex-col items-center gap-2 text-center">
			<div
				className={cn("flex size-10 items-center justify-center rounded-full", surfaceBg(level))}
			>
				<HugeiconsIcon className="size-5 text-foreground-muted" icon={ServerStack01Icon} />
			</div>
			<p className="text-balance font-semibold text-body">{getEmptyStateLabel(hasActiveFilters)}</p>
			<p className="text-balance text-foreground-muted text-xs-tight">
				{getEmptyStateBody(hasActiveFilters)}
			</p>
		</div>
	);
}
