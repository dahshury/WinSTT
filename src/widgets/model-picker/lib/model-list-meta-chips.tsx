"use client";

import {
	BookOpen02Icon,
	Coins01Icon,
	Mic01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useTranslations } from "use-intl";
import type {
	OpenRouterEndpoint,
	OpenRouterModel,
	OpenRouterPricing,
} from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";
import { FeatureSourceIcons } from "../ui/EndpointFeatureIcons";
import { ModelModalityIcons } from "../ui/ModelModalityIcons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/Tooltip";
import {
	type FeatureSource,
	hasDisplayableFeatures,
} from "./endpoint-feature-icons-test-helpers";
import {
	getPricingClassName,
	getPricingLabel,
} from "./model-list-content-virtualized-utils/class-names";
import {
	getFeaturedEndpoint,
} from "./model-list-content-virtualized-utils/header";
import {
	isPositiveNumber,
	shouldRenderInlineMeta,
} from "./model-list-content-virtualized-utils/items";
import {
	formatContextLength,
	getPricingTier,
	type getVariantClasses,
	getVariantIcon,
} from "./model-selector-display-utils";
import { MODEL_VARIANT_INFO } from "./model-variant-utils";

function ContextChip({
	contextLength,
}: {
	contextLength: number | null | undefined;
}) {
	const t = useTranslations("modelPicker");
	if (!isPositiveNumber(contextLength)) {
		return null;
	}
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className="inline-flex shrink-0 cursor-default items-center gap-1 text-[11px] text-foreground-muted tabular-nums"
					>
						<HugeiconsIcon
							className="size-3 opacity-70"
							icon={BookOpen02Icon}
						/>
						<span>{formatContextLength(contextLength)}</span>
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">{t("contextWindow")}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{t("contextWindowTip")}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function PricingChip({
	pricingInfo,
}: {
	pricingInfo: ReturnType<typeof getPricingTier> | null;
}) {
	const t = useTranslations("modelPicker");
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
				<p className="font-semibold text-body-sm">{t("pricing")}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{t("pricingTip")}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function parseRawPrice(raw: string | number | undefined): number | null {
	if (raw === undefined) {
		return null;
	}
	const parsed = typeof raw === "number" ? raw : Number.parseFloat(raw);
	if (!Number.isFinite(parsed)) {
		return null;
	}
	return parsed;
}

function formatUsd(value: number): string {
	const abs = Math.abs(value);
	const maximumFractionDigits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
	const minimumFractionDigits = abs >= 1 ? 2 : 0;
	return `$${value.toLocaleString("en-US", {
		maximumFractionDigits,
		minimumFractionDigits,
	})}`;
}

function formatTokenRate(raw: string | number | undefined): string | null {
	const parsed = parseRawPrice(raw);
	return parsed === null ? null : formatUsd(parsed * 1_000_000);
}

function formatRequestRate(raw: string | number | undefined): string | null {
	const parsed = parseRawPrice(raw);
	return parsed === null ? null : formatUsd(parsed);
}

function hasNonZeroPrice(raw: string | number | undefined): boolean {
	const parsed = parseRawPrice(raw);
	return parsed !== null && parsed !== 0;
}

function formatTokenPricing(
	pricing: OpenRouterPricing | undefined,
): string | null {
	const prompt = formatTokenRate(pricing?.prompt);
	const completion = formatTokenRate(pricing?.completion);
	if (!(prompt || completion)) {
		return null;
	}
	if (prompt && completion) {
		if (
			!(
				hasNonZeroPrice(pricing?.prompt) || hasNonZeroPrice(pricing?.completion)
			)
		) {
			return "$0 per 1M tokens";
		}
		if (hasNonZeroPrice(pricing?.completion)) {
			return `${prompt} input / ${completion} output per 1M tokens`;
		}
		return `${prompt} per 1M input tokens`;
	}
	if (prompt) {
		return `${prompt} per 1M input tokens`;
	}
	return `${completion} per 1M output tokens`;
}

function formatRequestPricing(raw: string | number | undefined): string | null {
	const request = formatRequestRate(raw);
	return request ? `${request} per request` : null;
}

const TRANSCRIPTION_DURATION_UNIT_BY_MODEL_ID = {
	"google/chirp-3": "min",
	"microsoft/mai-transcribe-1.5": "h",
	"mistralai/voxtral-mini-transcribe": "min",
	"nvidia/parakeet-tdt-0.6b-v3": "min",
	"openai/whisper-1": "min",
	"openai/whisper-large-v3": "min",
	"openai/whisper-large-v3-turbo": "h",
	"qwen/qwen3-asr-flash-2026-02-10": "s",
} as const;

type TranscriptionDurationUnit =
	(typeof TRANSCRIPTION_DURATION_UNIT_BY_MODEL_ID)[keyof typeof TRANSCRIPTION_DURATION_UNIT_BY_MODEL_ID];
type TranscriptionDurationModelId =
	keyof typeof TRANSCRIPTION_DURATION_UNIT_BY_MODEL_ID;

function isTranscriptionDurationModelId(
	id: string,
): id is TranscriptionDurationModelId {
	return Object.hasOwn(TRANSCRIPTION_DURATION_UNIT_BY_MODEL_ID, id);
}

function transcriptionDurationText(model: OpenRouterModel): string {
	return `${model.id} ${model.name} ${model.description ?? ""}`.toLowerCase();
}

function getTranscriptionDurationUnit(
	model: OpenRouterModel,
): TranscriptionDurationUnit | null {
	if (isTranscriptionDurationModelId(model.id)) {
		return TRANSCRIPTION_DURATION_UNIT_BY_MODEL_ID[model.id];
	}
	const text = transcriptionDurationText(model);
	if (/\bper[-\s]?second\b|\/second\b|\/s\b/.test(text)) {
		return "s";
	}
	if (/\bper[-\s]?minute\b|\/minute\b|\/min\b/.test(text)) {
		return "min";
	}
	if (/\bper[-\s]?hour\b|\/hour\b|\/h\b/.test(text)) {
		return "h";
	}
	return null;
}

function durationUnitHourlyMultiplier(unit: TranscriptionDurationUnit): number {
	switch (unit) {
		case "h":
			return 1;
		case "min":
			return 60;
		case "s":
			return 3_600;
	}
}

function formatTranscriptionHourlyRate(model: OpenRouterModel): string | null {
	const unit = getTranscriptionDurationUnit(model);
	if (!unit) {
		return null;
	}
	const pricing = model.pricing;
	const prompt = parseRawPrice(pricing?.prompt);
	if (prompt === null || prompt <= 0) {
		return null;
	}
	return `${formatUsd(prompt * durationUnitHourlyMultiplier(unit))}/h`;
}

function formatTranscriptionPricing(model: OpenRouterModel): string | null {
	const audioPricing = formatTranscriptionHourlyRate(model);
	const tokenPricing = audioPricing ?? formatTokenPricing(model.pricing);
	const requestPricing = formatRequestPricing(model.pricing?.request);
	if (requestPricing && tokenPricing) {
		return `${requestPricing} + ${tokenPricing}`;
	}
	return requestPricing ?? tokenPricing;
}

function formatPricingDetail(
	label: string,
	raw: string | number | undefined,
	unit: string,
	multiplier = 1,
): string | null {
	const parsed = parseRawPrice(raw);
	if (parsed === null) {
		return null;
	}
	return `${label}: ${formatUsd(parsed * multiplier)} ${unit}`;
}

function transcriptionPricingDetails(model: OpenRouterModel): string[] {
	const pricing = model.pricing;
	const audioPricing = formatTranscriptionHourlyRate(model);
	if (audioPricing) {
		return [
			`Audio: ${audioPricing}`,
			formatPricingDetail("Request", pricing?.request, "per API request"),
		].filter((detail): detail is string => detail !== null);
	}
	return [
		formatPricingDetail("Input", pricing?.prompt, "per 1M tokens", 1_000_000),
		formatPricingDetail(
			"Output",
			pricing?.completion,
			"per 1M tokens",
			1_000_000,
		),
		formatPricingDetail("Request", pricing?.request, "per API request"),
	].filter((detail): detail is string => detail !== null);
}

function hasRawPricing(pricing: OpenRouterPricing | undefined): boolean {
	return (
		parseRawPrice(pricing?.prompt) !== null ||
		parseRawPrice(pricing?.completion) !== null ||
		parseRawPrice(pricing?.request) !== null
	);
}

function PricingBreakdown({
	details,
}: {
	details: readonly string[];
}): ReactNode {
	if (details.length === 0) {
		return null;
	}
	return (
		<ul className="mt-1 space-y-0.5 text-foreground-muted text-xs-tight leading-relaxed">
			{details.map((detail) => (
				<li key={detail}>{detail}</li>
			))}
		</ul>
	);
}

function TranscriptionPricingChip({ model }: { model: OpenRouterModel }) {
	const t = useTranslations("modelPicker");
	const value = formatTranscriptionPricing(model);
	if (!value) {
		return null;
	}
	const details = transcriptionPricingDetails(model);
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className="inline-flex shrink-0 cursor-default items-center gap-1 font-semibold text-[11px] text-foreground-muted tabular-nums"
					>
						<HugeiconsIcon className="size-3 opacity-70" icon={Coins01Icon} />
						<span>{value}</span>
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">{t("openrouterPricing")}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{t("openrouterPricingTip")}
				</p>
				<PricingBreakdown details={details} />
				<p className="mt-1 text-foreground-muted text-xs-tight leading-relaxed">
					{t("openrouterPricingDurationNote")}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function TranscriptionChip() {
	const t = useTranslations("modelPicker");
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<div
						{...(props as ComponentPropsWithoutRef<"div">)}
						className="inline-flex shrink-0 cursor-default items-center gap-1 text-[11px] text-foreground-muted"
					>
						<HugeiconsIcon className="size-3 opacity-70" icon={Mic01Icon} />
						<span>{t("transcription")}</span>
					</div>
				)}
			/>
			<TooltipContent className="max-w-xs" side="top">
				<p className="font-semibold text-body-sm">{t("speechToText")}</p>
				<p className="text-foreground-muted text-xs-tight leading-relaxed">
					{t("speechToTextTip")}
				</p>
			</TooltipContent>
		</Tooltip>
	);
}

function buildInlineFeatureSource(
	endpoint: OpenRouterEndpoint | null,
	model: OpenRouterModel,
): FeatureSource {
	const source: FeatureSource = { id: model.id };
	if (model.variant !== undefined) {
		source.variant = model.variant;
	}
	if (endpoint?.quantization !== undefined) {
		source.quantization = endpoint.quantization;
	}
	const supportedParameters = Array.from(
		new Set([
			...(endpoint?.supported_parameters ?? []),
			...(model.supported_parameters ?? []),
		]),
	);
	if (supportedParameters.length > 0) {
		source.supported_parameters = supportedParameters;
	}
	return source;
}

function FeatureSourceChip({
	endpoint,
	model,
}: {
	endpoint: OpenRouterEndpoint | null;
	model: OpenRouterModel;
}) {
	const iconSource = buildInlineFeatureSource(endpoint, model);
	if (!hasDisplayableFeatures(iconSource)) {
		return null;
	}
	return (
		<div className="flex items-center">
			<FeatureSourceIcons
				className="gap-1"
				flat
				maxIcons={4}
				size="sm"
				source={iconSource}
			/>
		</div>
	);
}

function ModalitiesChip({
	modalities,
}: {
	modalities: readonly string[] | undefined;
}) {
	if (!modalities || modalities.length === 0) {
		return null;
	}
	return (
		<div className="flex items-center">
			<ModelModalityIcons
				className="gap-1"
				flat
				maxIcons={4}
				modalities={modalities}
				size="sm"
			/>
		</div>
	);
}

/** A faint middot separator between facts in the metadata line. */
function MetaSeparator() {
	return (
		<span aria-hidden="true" className="text-foreground-dim/40">
			·
		</span>
	);
}

/**
 * The metadata line beneath the model name — variant, context, price, feature
 * glyphs, and input modalities collapsed into ONE calm, left-aligned middot
 * strip (the `CardMetaRow` pattern shared with the STT card). Replaces the old
 * dense right-edge `divide-x` capsule so the facts read as a single scannable
 * row, subordinate to the name by size (11px) and tone (muted) rather than a
 * cluster of competing bordered chips.
 */
export function InlineModelMeta({
	model,
	pricingInfo,
	hasProviders,
	uniqueEndpoints,
	hasEndpoints,
	variant,
	variantClasses,
}: {
	model: OpenRouterModel;
	pricingInfo: ReturnType<typeof getPricingTier> | null;
	hasProviders: boolean;
	uniqueEndpoints: OpenRouterEndpoint[];
	hasEndpoints: boolean;
	variant?: OpenRouterModel["variant"];
	variantClasses?: ReturnType<typeof getVariantClasses> | null;
}) {
	const featuredEndpoint = getFeaturedEndpoint(
		uniqueEndpoints,
		hasEndpoints,
		hasProviders,
	);
	const modalities = model.architecture?.input_modalities;
	const outputModalities = model.architecture?.output_modalities;
	const isTranscriptionModel =
		outputModalities?.some((m) => m.toLowerCase() === "transcription") ?? false;
	const hasVariantToken = !!(variant && variantClasses);
	const hasTranscriptionPricing =
		isTranscriptionModel && hasRawPricing(model.pricing);
	const featureSource = buildInlineFeatureSource(featuredEndpoint, model);
	const hasFeatureIcons = hasDisplayableFeatures(featureSource);
	if (
		!(
			hasVariantToken ||
			isTranscriptionModel ||
			hasTranscriptionPricing ||
			hasFeatureIcons ||
			shouldRenderInlineMeta(
				model.context_length,
				pricingInfo,
				featuredEndpoint,
				modalities,
			)
		)
	) {
		return null;
	}

	const facts: ReactNode[] = [];
	const pushFact = (node: ReactNode | null) => {
		if (!node) {
			return;
		}
		if (facts.length > 0) {
			facts.push(<MetaSeparator key={`sep-${facts.length}`} />);
		}
		facts.push(node);
	};

	const hasContext = isPositiveNumber(model.context_length);
	pushFact(
		hasVariantToken ? (
			<VariantBadge
				key="variant"
				variant={variant}
				variantClasses={variantClasses}
			/>
		) : null,
	);
	pushFact(
		hasContext ? (
			<ContextChip contextLength={model.context_length} key="context" />
		) : null,
	);
	pushFact(
		hasTranscriptionPricing ? (
			<TranscriptionPricingChip key="price" model={model} />
		) : pricingInfo ? (
			<PricingChip key="price" pricingInfo={pricingInfo} />
		) : null,
	);
	pushFact(
		isTranscriptionModel ? <TranscriptionChip key="transcription" /> : null,
	);
	pushFact(
		hasFeatureIcons ? (
			<FeatureSourceChip
				endpoint={featuredEndpoint}
				key="features"
				model={model}
			/>
		) : null,
	);
	pushFact(
		modalities && modalities.length > 0 ? (
			<ModalitiesChip key="modalities" modalities={modalities} />
		) : null,
	);

	return (
		<div
			className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-foreground-muted leading-tight"
			data-slot="inline-model-meta"
		>
			{facts}
		</div>
	);
}

/**
 * Variant token (Free / Thinking / Nitro / …). Now a QUIET neutral chip that
 * lives in the metadata line beneath the name — not on the name row where it
 * competed with the title. `free` keeps a muted-emerald "cheap" tint; every
 * other variant is fully gray, so the icon shape + label carry the meaning.
 */
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
				"inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-px font-medium text-[10px] uppercase tracking-wide",
				variantClasses.bg,
				variantClasses.text,
			)}
		>
			{getVariantIcon(variant, "size-2.5")}
			{MODEL_VARIANT_INFO[variant]?.label}
		</span>
	);
}

export function ModelDescription({
	description,
}: {
	description: string | undefined;
}) {
	if (!description) {
		return null;
	}
	// Rendered as a block `<span>` (not a `<p>`) because it now drops into the
	// universal `ModelCard`'s `description` slot, which itself wraps the node in a
	// `<p>` — a nested `<p>` is invalid HTML. The `ps-[22px]` indent is gone too:
	// the universal card aligns the description as a column child (matching STT),
	// so it no longer needs to hang under the name past the maker icon.
	return (
		<Tooltip>
			<TooltipTrigger
				render={(props) => (
					<span
						{...(props as ComponentPropsWithoutRef<"span">)}
						className="line-clamp-2 cursor-default text-[11px] text-foreground-muted leading-snug"
					>
						{description}
					</span>
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
