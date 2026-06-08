"use client";

import { Button as BaseButton } from "@base-ui/react/button";
import {
	ArrowRight01Icon,
	CpuIcon,
	ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef } from "react";
import type { OpenRouterModel } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { surfaceBg, surfaceHoverBg, useSurface } from "@/shared/lib/surface";
import { ModelCard, NeutralHeaderIcon } from "../core/model-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import {
	computeModelHeaderState,
	getChevronClassName,
	getExpandAriaLabel,
	getProviderCountTooltip,
	resolveMakerIconSrc,
} from "./model-list-content-virtualized-utils";
import {
	InlineModelMeta,
	MakerIcon,
	ModelDescription,
	VariantBadge,
} from "./model-list-meta-chips";
import { VariantAccentStrip } from "./model-list-provider-grid";
import type { getVariantClasses } from "./model-selector-display-utils";
import { formatModelName } from "./model-selector-utils";
import { publicAsset } from "./public-asset";

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
	const level = Math.min(useSurface() + 1, 8);
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<BaseButton
						{...(props as ComponentPropsWithoutRef<"button">)}
						aria-expanded={isExpanded}
						aria-label={getExpandAriaLabel(isExpanded, providerCount)}
						className={cn(
							"inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 py-1 font-medium text-[10px] ring-1 transition-colors duration-150",
							isExpanded
								? "bg-accent/10 text-accent ring-accent/40"
								: cn(
										surfaceBg(level),
										surfaceHoverBg(Math.min(level + 1, 8)),
										"text-foreground-muted ring-divider hover:text-foreground hover:ring-border",
									),
						)}
						onClick={toggleProvidersList}
						type="button"
					>
						<HugeiconsIcon className="size-3" icon={ServerStack01Icon} />
						<span className="tabular-nums">{providerCount}</span>
						<HugeiconsIcon
							className={getChevronClassName(isExpanded)}
							icon={ArrowRight01Icon}
						/>
					</BaseButton>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">Hosting providers</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{getProviderCountTooltip(providerCount)}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The name line. The model name OWNS this line at full body size + semibold
 * (`text-body`, dominant) — the variant badge has moved off it into the meta
 * line below, so the title no longer shares a row with competing metadata.
 */
function ModelHeaderTitleRow({ model }: { model: OpenRouterModel }) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-1.5">
			<MakerIcon maker={model.maker} />
			<h3 className="min-w-0 truncate font-semibold text-body text-foreground leading-tight tracking-tight">
				{formatModelName(model.model_name ?? model.name, model.maker)}
			</h3>
		</div>
	);
}

interface ModelHeaderProps {
	hasProviders: boolean;
	isExpanded: boolean;
	isFavorite?: ((id: string) => boolean) | undefined;
	model: OpenRouterModel;
	onToggleExpanded: (modelId: string, nextOpen?: boolean) => void;
	onToggleFavorite?: ((id: string) => void) | undefined;
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
	return (
		<VariantAccentStrip gradient={variantClasses.gradient} variant={variant} />
	);
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

function modelPerf(
	model: OpenRouterModel,
): { accuracyScore: number; speedScore: number } | undefined {
	return typeof model.accuracy_score === "number" ||
		typeof model.speed_score === "number"
		? {
				accuracyScore: model.accuracy_score ?? 0.5,
				speedScore: model.speed_score ?? 0.5,
			}
		: undefined;
}

export function ModelHeader({
	model,
	isExpanded,
	hasProviders,
	parsedModelId,
	parsedProviderSlug,
	onToggleExpanded,
	isFavorite,
	onToggleFavorite,
}: ModelHeaderProps) {
	const state = computeModelHeaderState(
		model,
		parsedModelId,
		parsedProviderSlug,
		hasProviders,
	);
	// The OpenRouter model row is now a thin adapter over the universal
	// `ModelCard` — the SAME card the STT picker renders — so the two pickers
	// share one visual identity. Selection still flows through the combobox value
	// (`value={model.id}` + the root's `onValueChange`); the maker logo, formatted
	// name, meta strip, description, provider-grid expand button, and the
	// three-state selection indicator all map onto the card's slots. The provider
	// grid (`item.type === "providers"`) remains a peer row owned by the list.
	return (
		<ModelCard
			data-model-id={model.id}
			description={
				model.description ? (
					<ModelDescription description={model.description} />
				) : undefined
			}
			favorite={
				onToggleFavorite
					? {
							isFavorited: isFavorite?.(model.id) ?? false,
							label: formatModelName(
								model.model_name ?? model.name,
								model.maker,
							),
							onToggle: () => onToggleFavorite(model.id),
						}
					: undefined
			}
			footer={
				<ModelHeaderProvidersButton
					hasProviders={hasProviders}
					isExpanded={isExpanded}
					modelId={model.id}
					onToggleExpanded={onToggleExpanded}
					providerCount={state.uniqueEndpoints.length}
				/>
			}
			indirectlySelected={state.isProviderSelected}
			metaSlot={
				<InlineModelMeta
					hasEndpoints={state.hasEndpoints}
					hasProviders={hasProviders}
					model={model}
					pricingInfo={state.pricingInfo}
					uniqueEndpoints={state.uniqueEndpoints}
					variant={model.variant}
					variantClasses={state.variantClasses}
				/>
			}
			name={formatModelName(model.model_name ?? model.name, model.maker)}
			perf={modelPerf(model)}
			selected={state.isSelected}
			// No leading indicator at all — selection is shown ONLY by the card's
			// accent highlight (CARD_SELECTED), exactly like the STT picker. `false`
			// renders nothing and (unlike null/undefined) overrides ModelCard's
			// default check, so there's no checkbox before the name in any state.
			selectionIndicator={false}
			value={model.id}
		/>
	);
}

/** The leading icon for a maker group header: the provider's brand logo when we
 *  have one, else a neutral chip — matching the STT picker's AuthorLabel. */
export function MakerHeaderIcon({ maker }: { maker: string }) {
	const iconSrc = resolveMakerIconSrc(maker);
	if (!iconSrc) {
		return <NeutralHeaderIcon icon={CpuIcon} />;
	}
	return (
		<img
			alt=""
			className="size-4 shrink-0 rounded-[3px] object-cover"
			height={16}
			src={publicAsset(iconSrc)}
			width={16}
		/>
	);
}
