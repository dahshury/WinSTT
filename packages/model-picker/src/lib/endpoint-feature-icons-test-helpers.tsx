"use client";

import {
	Brain01Icon,
	BubbleChatIcon,
	CodeIcon,
	GlobeIcon,
	Layers01Icon,
	SparklesIcon,
	Wrench01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { OpenRouterEndpoint } from "@/shared/api/models";
import { cn } from "@/shared/lib/cn";

export interface FeatureSource {
	id?: string | undefined;
	quantization?: string | null | undefined;
	supported_parameters?: readonly string[] | null | undefined;
	variant?: string | null | undefined;
}

export interface FeatureIconConfig {
	bgClass: string;
	borderClass: string;
	description: string;
	icon: ReactNode;
	iconSm: ReactNode;
	label: string;
	shortLabel: string;
	textClass: string;
}

// fluidfunctionalism: capability glyphs are NEUTRAL. Each feature reads from its
// icon SHAPE + tooltip (wrench=tools, brain=reasoning, code=structured, …), so
// every chip shares one muted gray treatment instead of a seven-hue rainbow. The
// provider sub-cards stay calmly grayscale; color is reserved for selection.
const NEUTRAL_FEATURE_CHROME = {
	bgClass: "bg-foreground/[0.04]",
	textClass: "text-foreground-muted",
	borderClass: "border-border/60",
} as const;

const FEATURE_ICONS: Record<string, FeatureIconConfig> = {
	tools: {
		icon: <HugeiconsIcon className="size-3" icon={Wrench01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Wrench01Icon} />,
		label: "Tools",
		shortLabel: "FN",
		description:
			"Supports function/tool calling. The model can execute functions, call APIs, and use external tools to perform actions beyond text generation.",
		...NEUTRAL_FEATURE_CHROME,
	},
	parallel_tool_calls: {
		icon: <HugeiconsIcon className="size-3" icon={Layers01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Layers01Icon} />,
		label: "Parallel",
		shortLabel: "||",
		description:
			"Supports parallel tool calls. The model can execute multiple tools simultaneously instead of sequentially, improving response speed.",
		...NEUTRAL_FEATURE_CHROME,
	},
	reasoning: {
		icon: <HugeiconsIcon className="size-3" icon={Brain01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Brain01Icon} />,
		label: "Reasoning",
		shortLabel: "R",
		description:
			"Supports reasoning output. The model can show its step-by-step thinking process and explain how it arrives at conclusions.",
		...NEUTRAL_FEATURE_CHROME,
	},
	include_reasoning: {
		icon: <HugeiconsIcon className="size-3" icon={SparklesIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={SparklesIcon} />,
		label: "Inc. Reasoning",
		shortLabel: "+R",
		description:
			"Can include reasoning in response. The model can optionally include its internal reasoning process in the output when requested.",
		...NEUTRAL_FEATURE_CHROME,
	},
	structured_outputs: {
		icon: <HugeiconsIcon className="size-3" icon={CodeIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={CodeIcon} />,
		label: "Structured",
		shortLabel: "{}",
		description:
			"Supports structured output schema. The model can return data in a predefined JSON schema format, ensuring consistent output structure.",
		...NEUTRAL_FEATURE_CHROME,
	},
	response_format: {
		icon: <HugeiconsIcon className="size-3" icon={BubbleChatIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={BubbleChatIcon} />,
		label: "JSON",
		shortLabel: "JS",
		description:
			"Supports JSON response format. The model can return responses in valid JSON format, useful for programmatic integration.",
		...NEUTRAL_FEATURE_CHROME,
	},
	web_search_options: {
		icon: <HugeiconsIcon className="size-3" icon={GlobeIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={GlobeIcon} />,
		label: "Search",
		shortLabel: "WEB",
		description:
			"Supports web search capabilities. The model can search the internet to find current information and answer questions with up-to-date data.",
		...NEUTRAL_FEATURE_CHROME,
	},
};

const FEATURE_PRIORITY = [
	"tools",
	"parallel_tool_calls",
	"reasoning",
	"structured_outputs",
	"include_reasoning",
	"response_format",
	"web_search_options",
] as const;

const REASONING_PARAM_KEYS: ReadonlySet<string> = new Set([
	"reasoning",
	"include_reasoning",
]);

const REASONING_ID_PATTERNS: readonly RegExp[] = [
	/(?:^|\/)o[134](?:-|$)/i,
	/[-/]reasoning(?:[-/]|$)/i,
	/[-/]think(?:ing)?(?:[-/]|$)/i,
	/[-/]reasoner(?:[-/]|$)/i,
];

const QUANTIZATION_LABELS: Record<string, string> = {
	fp32: "FP32",
	fp16: "FP16",
	bf16: "BF16",
	fp8: "FP8",
	fp6: "FP6",
	fp4: "FP4",
	int8: "INT8",
	int4: "INT4",
	awq: "AWQ",
	gptq: "GPTQ",
	gguf: "GGUF",
};

export function getQuantizationLabel(
	endpoint: FeatureSource,
): string | undefined {
	const quant = endpoint.quantization;
	if (!quant) {
		return;
	}
	const normalized = quant.toLowerCase();
	if (normalized === "unknown") {
		return;
	}
	return QUANTIZATION_LABELS[normalized];
}

function hasImplicitReasoningSupport(source: FeatureSource): boolean {
	if (source.variant === "thinking") {
		return true;
	}
	const id = source.id;
	return id ? REASONING_ID_PATTERNS.some((re) => re.test(id)) : false;
}

function sourceSupportsReasoning(source: FeatureSource): boolean {
	return (
		hasImplicitReasoningSupport(source) ||
		(source.supported_parameters?.some((p) => REASONING_PARAM_KEYS.has(p)) ??
			false)
	);
}

function buildSupportedParamsSet(source: FeatureSource): Set<string> {
	const supportedParamsSet = new Set<string>(source.supported_parameters ?? []);
	if (
		!supportedParamsSet.has("reasoning") &&
		!supportedParamsSet.has("include_reasoning") &&
		hasImplicitReasoningSupport(source)
	) {
		supportedParamsSet.add("reasoning");
	}
	return supportedParamsSet;
}

export interface ChipChromeOptions {
	flat: boolean;
	isSmall: boolean;
	shouldShowLabel: boolean;
}

export function getChipSizeClass({
	flat,
	isSmall,
	shouldShowLabel,
}: ChipChromeOptions): string {
	if (shouldShowLabel) {
		return isSmall ? "px-1 py-0.5" : "px-1.5 py-0.5";
	}
	if (flat) {
		return isSmall ? "h-4 w-4" : "h-5 w-5";
	}
	return isSmall ? "h-4 w-4 p-0.5" : "h-5 w-5 p-0.5";
}

export function getChipIcon(
	config: FeatureIconConfig,
	isSmall: boolean,
): React.ReactNode {
	return isSmall ? config.iconSm : config.icon;
}

export function getChipLabelClass(isSmall: boolean): string {
	return cn(
		"font-semibold uppercase tracking-wider",
		isSmall ? "text-[10px] sm:text-[8px]" : "text-[10px] sm:text-[9px]",
	);
}

export function buildQuantizationFeature(quantLabel: string): {
	key: string;
	config: FeatureIconConfig;
} {
	return {
		key: "quantization",
		config: {
			icon: <HugeiconsIcon className="size-3" icon={ZapIcon} />,
			iconSm: <HugeiconsIcon className="size-2.5" icon={ZapIcon} />,
			label: quantLabel,
			shortLabel: quantLabel,
			description: `Quantization: ${quantLabel}. This provider serves the model with ${quantLabel} quantization, which reduces model size and improves inference speed while maintaining acceptable quality.`,
			...NEUTRAL_FEATURE_CHROME,
		},
	};
}

export function resolveParamFeature(
	param: string,
	supportedParamsSet: Set<string>,
): FeatureIconConfig | null {
	if (!supportedParamsSet.has(param)) {
		return null;
	}
	return FEATURE_ICONS[param] ?? null;
}

export function appendSupportedParams(
	features: Array<{ key: string; config: FeatureIconConfig }>,
	supportedParamsSet: Set<string>,
	maxIcons: number,
): void {
	for (const param of FEATURE_PRIORITY) {
		if (features.length >= maxIcons) {
			break;
		}
		const config = resolveParamFeature(param, supportedParamsSet);
		if (config) {
			features.push({ key: param, config });
		}
	}
}

export function buildFeatures(
	endpoint: OpenRouterEndpoint,
	maxIcons: number,
): Array<{ key: string; config: FeatureIconConfig }> {
	return buildFeaturesFromSource(endpoint, maxIcons);
}

export function buildFeaturesFromSource(
	source: FeatureSource,
	maxIcons: number,
): Array<{ key: string; config: FeatureIconConfig }> {
	const supportedParamsSet = buildSupportedParamsSet(source);
	const quantLabel = getQuantizationLabel(source);
	const features: Array<{ key: string; config: FeatureIconConfig }> = [];

	if (quantLabel) {
		features.push(buildQuantizationFeature(quantLabel));
	}

	appendSupportedParams(features, supportedParamsSet, maxIcons);
	return features;
}

export function hasDisplayableFeatures(source: FeatureSource): boolean {
	const supportedParamsSet = buildSupportedParamsSet(source);
	return (
		!!getQuantizationLabel(source) ||
		sourceSupportsReasoning(source) ||
		FEATURE_PRIORITY.some((param) => supportedParamsSet.has(param))
	);
}
