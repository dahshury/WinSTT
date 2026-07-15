import {
	BinaryCodeIcon,
	Brain01Icon,
	CodeIcon,
	HardDriveDownloadIcon,
	Image01Icon,
	Layers01Icon,
	Mic01Icon,
	NeuralNetworkIcon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { OllamaModel } from "@/shared/api/models";
import type {
	ModelSpec,
	ModelSpecFact,
	ModelSpecFeature,
} from "@/shared/ui/model-spec-card";
import { getProviderIconWithFallback } from "@/shared/ui/model-picker/lib/provider-icons";
import { formatContextTokens } from "@/shared/ui/model-picker/lib/model-spec-format";
import {
	formatOllamaDisplayName,
	formatOllamaSize,
	getOllamaFamily,
	getOllamaPublisher,
	resolveOllamaParameterSize,
	resolveOllamaQuantization,
} from "./family-helpers";
import {
	normalizedCapabilitySet,
	supportsOllamaToolCalling,
	visibleCapabilities,
} from "./ollama-description-helpers";

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

function buildOllamaFeatures(model: OllamaModel): ModelSpecFeature[] {
	const capabilities = model.capabilities ?? undefined;
	const features: ModelSpecFeature[] = [];
	if (supportsOllamaToolCalling(capabilities)) {
		features.push({
			key: "tools",
			icon: Wrench01Icon,
			label: "Tool calling",
			description: "Supports function / tool calling.",
		});
	}
	if (normalizedCapabilitySet(capabilities).has("thinking")) {
		features.push({
			key: "reasoning",
			icon: Brain01Icon,
			label: "Reasoning",
			description: "Supports step-by-step reasoning.",
		});
	}
	for (const label of visibleCapabilities(capabilities, {
		excludeTools: true,
	})) {
		if (label.toLowerCase() === "thinking") {
			continue;
		}
		features.push({
			key: `cap-${label}`,
			icon: capabilityIcon(label),
			label,
			description: "Model capability.",
		});
	}
	return features;
}

/**
 * Build the hover-card spec for an installed Ollama model. Local models carry no
 * benchmark source, so there are no perf bars; `description` is optional (the
 * live `/api/tags` payload has none — the caller passes one when it has the
 * catalog description).
 */
export function buildOllamaSpec(
	model: OllamaModel,
	description?: string | undefined,
): ModelSpec {
	const family = getOllamaFamily(model);
	const publisher = getOllamaPublisher(family);

	const facts: ModelSpecFact[] = [];
	const parameterSize = resolveOllamaParameterSize(model);
	if (parameterSize) {
		facts.push({
			key: "params",
			label: "Parameters",
			value: parameterSize,
			icon: NeuralNetworkIcon,
		});
	}
	const context = formatContextTokens(model.contextLength);
	if (context) {
		facts.push({
			key: "context",
			label: "Context",
			value: context,
			icon: Layers01Icon,
		});
	}
	const quant = resolveOllamaQuantization(model);
	if (quant) {
		facts.push({
			key: "quant",
			label: "Quantization",
			value: quant.toUpperCase(),
			icon: BinaryCodeIcon,
		});
	}
	if (typeof model.size === "number" && model.size > 0) {
		facts.push({
			key: "size",
			label: "Size on disk",
			value: formatOllamaSize(model.size),
			icon: HardDriveDownloadIcon,
		});
	}

	return {
		name: formatOllamaDisplayName(model.name),
		makerLabel: publisher.label,
		makerLogoSrc: getProviderIconWithFallback(publisher.slug),
		description: description || undefined,
		features: buildOllamaFeatures(model),
		facts,
	};
}
