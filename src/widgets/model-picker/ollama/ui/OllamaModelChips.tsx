"use client";

import {
	AlertCircleIcon,
	BinaryCodeIcon,
	Brain01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useTranslations } from "use-intl";
import type { OpenRouterEndpoint } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { Tooltip as ContentTooltip } from "@/shared/ui/tooltip";
import {
	getProviderIconWithFallback,
	resolveProviderIcon,
} from "../../lib/provider-icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/Tooltip";
import { EndpointFeatureIcons } from "../../ui/EndpointFeatureIcons";
import {
	getOllamaPublisher,
	getOllamaPublisherBySlug,
	formatOllamaSize,
} from "../lib/family-helpers";
import {
	normalizedCapabilitySet,
	supportsOllamaToolCalling,
	visibleCapabilities,
} from "../lib/ollama-description-helpers";
import type { OllamaFitInfo } from "./ollama-selector-types";

// ── Shared chips (used by trigger + row) ──────────────────────────────

/** The small publisher logo rendered before a model name inside the shared
 *  {@link ModelCard} (installed / recommended / library rows) so every Ollama
 *  card carries its maker mark, mirroring the OpenRouter picker. Falls back to a
 *  gray initials chip when the publisher has no logo. */
export function OllamaMakerIcon({ slug }: { slug: string }) {
	const icon = resolveProviderIcon(slug);
	if (icon) {
		return (
			<img
				alt=""
				className="size-4 shrink-0 rounded-[3px] object-cover"
				height={16}
				src={icon}
				width={16}
			/>
		);
	}
	// No bundled logo → neutral initials chip (never the misleading OpenRouter "O").
	return (
		<span className="flex size-4 shrink-0 items-center justify-center rounded-[3px] bg-foreground/[0.08] font-semibold text-[9px] text-foreground-muted uppercase">
			{getOllamaPublisherBySlug(slug).label.charAt(0) || "?"}
		</span>
	);
}

export function PublisherChip({ family }: { family: string }) {
	const publisher = getOllamaPublisher(family);
	const iconSrc = getProviderIconWithFallback(publisher.slug);
	return (
		<span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-secondary/60 px-1.5 py-0.5 font-medium text-[10px] text-foreground-secondary leading-none">
			<img
				alt=""
				className="size-3 rounded-[2px] object-cover"
				height={12}
				src={iconSrc}
				width={12}
			/>
			{publisher.label}
		</span>
	);
}

/**
 * Reasoning-capability marker. Renders when the model's `capabilities`
 * array (fetched from Ollama's `/api/show`) advertises `thinking`. Rendered
 * as a quiet neutral capability pill (matching the Library capability chips)
 * — in the fluidfunctionalism palette the icon shape carries the meaning, so
 * the chip stays fully grayscale rather than glowing purple.
 */
function ThinkingChip({
	capabilities,
}: {
	capabilities: readonly string[] | undefined;
}) {
	const t = useTranslations("modelPicker");
	if (!normalizedCapabilitySet(capabilities).has("thinking")) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-px font-medium text-[9.5px] text-foreground-muted leading-none"
					>
						<HugeiconsIcon className="size-2.5" icon={Brain01Icon} />
						{t("reasoning")}
					</span>
				)}
			/>
			<TooltipContent>{t("reasoningTip")}</TooltipContent>
		</Tooltip>
	);
}

const OLLAMA_TOOL_CAPABILITY_ENDPOINT = {
	context_length: 0,
	model_name: "Ollama model",
	name: "Ollama model",
	pricing: {},
	provider_name: "Ollama",
	supported_parameters: ["tools"],
	tag: "ollama",
} as OpenRouterEndpoint;

function OllamaToolCapabilityBadge({
	capabilities,
	className,
}: {
	capabilities: readonly string[] | null | undefined;
	className?: string;
}) {
	if (!supportsOllamaToolCalling(capabilities)) {
		return null;
	}
	return (
		<EndpointFeatureIcons
			className={cn("gap-1", className)}
			endpoint={OLLAMA_TOOL_CAPABILITY_ENDPOINT}
			flat
			maxIcons={1}
			showLabels
			size="sm"
		/>
	);
}

function CapabilityChips({
	capabilities,
}: {
	capabilities: readonly string[] | undefined;
}) {
	const t = useTranslations("modelPicker");
	const labels = visibleCapabilities(capabilities, { excludeTools: true });
	if (labels.length === 0) {
		return null;
	}
	return (
		<>
			{labels.map((label) => (
				<Tooltip key={label}>
					<TooltipTrigger
						render={(props) => (
							<span
								{...(props as ComponentPropsWithoutRef<"span">)}
								className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 py-px font-medium text-[9.5px] text-foreground-muted leading-none"
							>
								<HugeiconsIcon className="size-2.5" icon={BinaryCodeIcon} />
								{label}
							</span>
						)}
					/>
					<TooltipContent>{t("ollamaCapabilityTip")}</TooltipContent>
				</Tooltip>
			))}
		</>
	);
}

export function InstalledCapabilityBadges({
	capabilities,
}: {
	capabilities: readonly string[] | undefined;
}): ReactNode {
	const hasThinking = normalizedCapabilitySet(capabilities).has("thinking");
	const hasTools = supportsOllamaToolCalling(capabilities);
	const labels = visibleCapabilities(capabilities, { excludeTools: true });
	if (!hasThinking && !hasTools && labels.length === 0) {
		return null;
	}
	return (
		<>
			<OllamaToolCapabilityBadge capabilities={capabilities} />
			<ThinkingChip capabilities={capabilities} />
			<CapabilityChips capabilities={capabilities} />
		</>
	);
}

export function WontFitChip({ fit }: { fit: OllamaFitInfo | undefined }) {
	const t = useTranslations("modelPicker");
	if (!fit || fit.fits) {
		return null;
	}
	const tooltip =
		fit.shortfall === "vram"
			? t("wontFitVram", {
					required: formatOllamaSize(fit.requiredBytes),
					available: formatOllamaSize(fit.availableBytes),
				})
			: t("wontFitRam", {
					required: formatOllamaSize(fit.requiredBytes),
					available: formatOllamaSize(fit.availableBytes),
				});
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-error/10 px-1.5 font-medium text-[10px] text-error leading-none ring-1 ring-error/30 ring-inset"
					>
						<HugeiconsIcon className="size-2.5" icon={AlertCircleIcon} />
						{t("wontFit")}
					</span>
				)}
			/>
			<TooltipContent side="top">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

/** The amber "Recommended" star badge shown on a curated model's card now that
 *  recommended models live inside their maker group rather than a separate
 *  maker-less "Recommended" section. */
export function RecommendedStar() {
	const t = useTranslations("modelPicker");
	return (
		<ContentTooltip content={t("recommendedTip")} side="top">
			<span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-favorite/[0.12] px-1.5 font-medium text-[10px] text-favorite leading-none">
				<HugeiconsIcon className="size-2.5 fill-favorite" icon={StarIcon} />
				{t("recommended")}
			</span>
		</ContentTooltip>
	);
}
