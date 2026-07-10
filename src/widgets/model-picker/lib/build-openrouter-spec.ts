import {
	Brain01Icon,
	Calendar03Icon,
	CodeIcon,
	AiCloud01Icon,
	GlobeIcon,
	Image01Icon,
	Layers01Icon,
	Structure01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { ModelsDevEntry } from "@/entities/llm-catalog";
import type { OpenRouterModel } from "@/shared/api/models";
import type {
	ModelSpec,
	ModelSpecFact,
	ModelSpecFeature,
} from "@/shared/ui/model-spec-card";
import {
	formatContextTokens,
	formatSpecDate,
	priceTierFromPricing,
} from "./model-spec-format";
import { formatMaker, formatModelName } from "./model-selector-utils";
import { getProviderIconWithFallback } from "./provider-icons";

function hasParam(model: OpenRouterModel, name: string): boolean {
	return model.supported_parameters?.includes(name) ?? false;
}

function acceptsImage(
	model: OpenRouterModel,
	enrichment: ModelsDevEntry | null,
): boolean {
	if (model.architecture?.input_modalities?.includes("image")) {
		return true;
	}
	return enrichment?.inputModalities?.includes("image") ?? false;
}

function buildOpenRouterFeatures(
	model: OpenRouterModel,
	enrichment: ModelsDevEntry | null,
): ModelSpecFeature[] {
	const features: ModelSpecFeature[] = [];
	const reasons =
		hasParam(model, "reasoning") ||
		hasParam(model, "include_reasoning") ||
		model.variant === "thinking" ||
		enrichment?.reasoning === true;
	if (reasons) {
		features.push({
			key: "reasoning",
			icon: Brain01Icon,
			label: "Reasoning",
			description: "The model can show step-by-step thinking.",
		});
	}
	if (hasParam(model, "tools") || enrichment?.toolCall === true) {
		features.push({
			key: "tools",
			icon: Wrench01Icon,
			label: "Tool calling",
			description: "Can call functions, APIs, and external tools.",
		});
	}
	if (hasParam(model, "structured_outputs")) {
		features.push({
			key: "structured",
			icon: CodeIcon,
			label: "Structured",
			description: "Can return output in a predefined JSON schema.",
		});
	}
	if (hasParam(model, "web_search_options")) {
		features.push({
			key: "web-search",
			icon: GlobeIcon,
			label: "Web search",
			description: "Can search the web for current information.",
		});
	}
	if (acceptsImage(model, enrichment)) {
		features.push({
			key: "vision",
			icon: Image01Icon,
			label: "Vision",
			description: "Accepts image inputs alongside text.",
		});
	}
	return features;
}

function variantLabel(variant: OpenRouterModel["variant"]): string | undefined {
	if (!variant) {
		return;
	}
	return variant.charAt(0).toUpperCase() + variant.slice(1);
}

/**
 * Build the hover-card spec for an OpenRouter cloud model, enriched with
 * models.dev metadata when a match was found. `enrichment` is `null` when the
 * dataset hasn't matched (or hasn't loaded yet — pass `loading` so the card
 * shows a "Loading details…" hint while catalog data is already visible).
 */
export function buildOpenRouterSpec(
	model: OpenRouterModel,
	enrichment: ModelsDevEntry | null,
	options?: { loading?: boolean | undefined },
): ModelSpec {
	const price = model.pricing ? priceTierFromPricing(model.pricing) : null;
	const developer = enrichment?.developer ?? formatMaker(model.maker);

	const facts: ModelSpecFact[] = [
		{
			key: "provider",
			label: "Provider",
			value: "OpenRouter",
			logoSrc: getProviderIconWithFallback("openrouter"),
		},
		{
			key: "developer",
			label: "Developer",
			value: developer,
			icon: Structure01Icon,
		},
	];
	const knowledge = formatSpecDate(enrichment?.knowledge);
	if (knowledge) {
		facts.push({
			key: "knowledge",
			label: "Knowledge cutoff",
			value: knowledge,
			icon: Calendar03Icon,
		});
	}
	const added = formatSpecDate(enrichment?.releaseDate);
	if (added) {
		facts.push({
			key: "added",
			label: "Released",
			value: added,
			icon: Calendar03Icon,
		});
	}
	const context = formatContextTokens(
		model.context_length ?? enrichment?.contextLimit,
	);
	if (context) {
		facts.push({
			key: "context",
			label: "Context",
			value: context,
			icon: Layers01Icon,
		});
	}

	return {
		name: formatModelName(model.model_name ?? model.name, model.maker),
		variant: variantLabel(model.variant),
		makerLabel: developer,
		makerLogoSrc: getProviderIconWithFallback(model.maker ?? "openrouter"),
		makerIcon: AiCloud01Icon,
		description: model.description || undefined,
		priceTier: price?.tier,
		priceLabel: price?.label,
		features: buildOpenRouterFeatures(model, enrichment),
		facts,
		sourceLabel: enrichment ? "via models.dev" : undefined,
		loading: options?.loading && !enrichment ? true : undefined,
	};
}
