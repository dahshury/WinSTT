"use client";

import {
	AlertCircleIcon,
	BinaryCodeIcon,
	Brain01Icon,
	CodeIcon,
	FlashIcon,
	Image01Icon,
	Mic01Icon,
	StarIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useTranslations } from "use-intl";
import { isLiteOllamaModel } from "@/entities/llm-catalog";
import type { OpenRouterEndpoint } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { Tooltip as ContentTooltip } from "@/shared/ui/tooltip";
import {
	getProviderIconWithFallback,
	resolveProviderIcon,
} from "../../lib/provider-icons";
import { AuthorBadge } from "../../ui/AuthorBadge";
import { MakerLogo } from "../../ui/MakerLogo";
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
	// No bundled logo → neutral initials chip (never the misleading OpenRouter "O").
	return (
		<MakerLogo
			fallback={getOllamaPublisherBySlug(slug).label.charAt(0) || "?"}
			fallbackClassName="font-semibold text-[9px] uppercase"
			src={resolveProviderIcon(slug)}
		/>
	);
}

export function PublisherChip({ family }: { family: string }) {
	const publisher = getOllamaPublisher(family);
	return (
		<AuthorBadge
			label={publisher.label}
			logoSrc={getProviderIconWithFallback(publisher.slug)}
		/>
	);
}

const COMPACT_CAPABILITY_CHIP_CLASSES =
	"inline-flex size-5 shrink-0 cursor-default items-center justify-center rounded-md border border-border/60 bg-foreground/[0.04] text-foreground-muted transition-[transform,box-shadow,color] duration-150 hover:scale-105 hover:shadow-sm";

function CompactCapabilityChip({
	icon,
	label,
	tooltip,
}: {
	icon: IconSvgElement;
	label: string;
	tooltip: ReactNode;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						aria-label={label}
						className={COMPACT_CAPABILITY_CHIP_CLASSES}
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-2.5"
							icon={icon}
						/>
					</span>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">{label}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{tooltip}
				</p>
			</TooltipContent>
		</Tooltip>
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
	compact = false,
}: {
	capabilities: readonly string[] | undefined;
	compact?: boolean;
}) {
	const t = useTranslations("modelPicker");
	if (!normalizedCapabilitySet(capabilities).has("thinking")) {
		return null;
	}
	if (compact) {
		return (
			<CompactCapabilityChip
				icon={Brain01Icon}
				label={t("reasoning")}
				tooltip={t("reasoningTip")}
			/>
		);
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
	compact = false,
}: {
	capabilities: readonly string[] | null | undefined;
	className?: string;
	compact?: boolean;
}) {
	if (!supportsOllamaToolCalling(capabilities)) {
		return null;
	}
	return (
		<EndpointFeatureIcons
			className={cn("gap-1", className)}
			endpoint={OLLAMA_TOOL_CAPABILITY_ENDPOINT}
			flat={!compact}
			maxIcons={1}
			showLabels={!compact}
			size="sm"
		/>
	);
}

function capabilityIcon(label: string): IconSvgElement {
	switch (label.toLowerCase()) {
		case "vision":
			return Image01Icon;
		case "audio":
			return Mic01Icon;
		case "fill-in-middle":
			return CodeIcon;
		default:
			return BinaryCodeIcon;
	}
}

function CapabilityChips({
	capabilities,
	compact = false,
}: {
	capabilities: readonly string[] | undefined;
	compact?: boolean;
}) {
	const labels = visibleCapabilities(capabilities, { excludeTools: true });
	if (labels.length === 0) {
		return null;
	}
	return (
		<>
			{labels.map((label) => (
				<CapabilityChip compact={compact} key={label} label={label} />
			))}
		</>
	);
}

function CapabilityChip({
	compact,
	label,
}: {
	compact: boolean;
	label: string;
}) {
	const t = useTranslations("modelPicker");
	if (compact) {
		return (
			<CompactCapabilityChip
				icon={capabilityIcon(label)}
				label={label}
				tooltip={t("ollamaCapabilityTip")}
			/>
		);
	}
	return (
		<Tooltip>
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
	);
}

export function InstalledCapabilityBadges({
	capabilities,
	compact = false,
}: {
	capabilities: readonly string[] | undefined;
	compact?: boolean;
}): ReactNode {
	const hasThinking = normalizedCapabilitySet(capabilities).has("thinking");
	const hasTools = supportsOllamaToolCalling(capabilities);
	const labels = visibleCapabilities(capabilities, { excludeTools: true });
	if (!(hasThinking || hasTools) && labels.length === 0) {
		return null;
	}
	return (
		<>
			<OllamaToolCapabilityBadge
				capabilities={capabilities}
				compact={compact}
			/>
			<ThinkingChip capabilities={capabilities} compact={compact} />
			<CapabilityChips capabilities={capabilities} compact={compact} />
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

/** Quiet neutral "Lite" pill for sub-4B models: they run the reduced
 *  `{text}`-only post-processing schema (see `isLiteOllamaModel`), which skips
 *  dictionary auto-learning, history tags, and privacy markers in exchange for
 *  reliable instruction-following at low VRAM. Grayscale like the capability
 *  chips — informational, not a warning. */
export function LiteTierChip({ model }: { model: string }) {
	const t = useTranslations("modelPicker");
	if (!isLiteOllamaModel(model)) {
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
						<HugeiconsIcon className="size-2.5" icon={FlashIcon} />
						{t("liteTier")}
					</span>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				{t("liteTierTip")}
			</TooltipContent>
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
