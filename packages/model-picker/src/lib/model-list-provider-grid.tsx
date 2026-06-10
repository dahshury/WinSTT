"use client";

import { Combobox } from "@base-ui/react/combobox";
import {
	BookOpen02Icon,
	CpuIcon,
	MessageOutgoing02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import { useTranslations } from "use-intl";
import type { OpenRouterEndpoint, OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { Collapsible } from "../core/Collapsible";
import { EndpointFeatureIcons } from "../ui/EndpointFeatureIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import {
	getEndpointProviderSlug,
	getPricingClassName,
	getPricingLabel,
	getProviderCardClassName,
	getSelectionDotClassName,
	isPositiveNumber,
	isProviderSelected,
	type ModelVariantKey,
	shouldShowStatsRow,
	VARIANT_GRADIENT_MAP,
} from "./model-list-content-virtualized-utils";
import {
	formatContextLength,
	getPricingTier,
} from "./model-selector-display-utils";

// Quiet neutral top hairline. Once a 4px per-variant rainbow ribbon; now a
// faint 1px structural seam (the variant meaning lives in the meta-line token).
export function VariantAccentStrip({
	variant,
	gradient,
}: {
	variant: ModelVariantKey;
	gradient: string;
}) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-md bg-gradient-to-r",
				gradient,
				VARIANT_GRADIENT_MAP[variant],
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
						<HugeiconsIcon
							className="size-3 shrink-0 text-foreground-muted"
							icon={icon}
						/>
						<span className="truncate font-medium text-foreground-secondary">
							{formatContextLength(value)}
						</span>
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">{tooltipTitle}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{tooltipBody}
				</p>
			</TooltipContent>
		</Tooltip>
	);
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
	const t = useTranslations("modelPicker");
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
				<p className="font-semibold text-body-sm">{t("pricing")}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{t("pricingProviderTip")}
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

function ProviderCard({
	model,
	endpoint,
	providerSlug,
	isSelected,
	onSelect,
}: ProviderCardProps) {
	const pricingInfo = getPricingTier(endpoint.pricing);
	const selectProvider = () => onSelect(model.id, providerSlug);
	const level = Math.min(useSurface() + 1, 8);
	return (
		<Combobox.Item
			className={getProviderCardClassName(
				isSelected,
				cn(surfaceBg(level), surfaceHoverBg(Math.min(level + 1, 8))),
			)}
			onClick={selectProvider}
			value={`${model.id}@${providerSlug}`}
		>
			<span className={getSelectionDotClassName(isSelected)} />

			<div className="flex min-w-0 items-center gap-1.5 pe-3">
				<HugeiconsIcon
					className="size-3 shrink-0 text-foreground-muted"
					icon={CpuIcon}
				/>
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
				<EndpointFeatureIcons
					className="gap-1"
					endpoint={endpoint}
					flat
					maxIcons={4}
					size="sm"
				/>
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
				const selected = isProviderSelected(
					model,
					providerSlug,
					parsedModelId,
					parsedProviderSlug,
				);
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

export function ProvidersRow({
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
