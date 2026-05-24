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

export const FEATURE_ICONS: Record<string, FeatureIconConfig> = {
	tools: {
		icon: <HugeiconsIcon className="size-3" icon={Wrench01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Wrench01Icon} />,
		label: "Tools",
		shortLabel: "FN",
		description:
			"Supports function/tool calling. The model can execute functions, call APIs, and use external tools to perform actions beyond text generation.",
		bgClass: "bg-blue-500/10 dark:bg-blue-500/15",
		textClass: "text-blue-600 dark:text-blue-400",
		borderClass: "border-blue-500/20",
	},
	parallel_tool_calls: {
		icon: <HugeiconsIcon className="size-3" icon={Layers01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Layers01Icon} />,
		label: "Parallel",
		shortLabel: "||",
		description:
			"Supports parallel tool calls. The model can execute multiple tools simultaneously instead of sequentially, improving response speed.",
		bgClass: "bg-indigo-500/10 dark:bg-indigo-500/15",
		textClass: "text-indigo-600 dark:text-indigo-400",
		borderClass: "border-indigo-500/20",
	},
	reasoning: {
		icon: <HugeiconsIcon className="size-3" icon={Brain01Icon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={Brain01Icon} />,
		label: "Reasoning",
		shortLabel: "R",
		description:
			"Supports reasoning output. The model can show its step-by-step thinking process and explain how it arrives at conclusions.",
		bgClass: "bg-purple-500/10 dark:bg-purple-500/15",
		textClass: "text-purple-600 dark:text-purple-400",
		borderClass: "border-purple-500/20",
	},
	include_reasoning: {
		icon: <HugeiconsIcon className="size-3" icon={SparklesIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={SparklesIcon} />,
		label: "Inc. Reasoning",
		shortLabel: "+R",
		description:
			"Can include reasoning in response. The model can optionally include its internal reasoning process in the output when requested.",
		bgClass: "bg-violet-500/10 dark:bg-violet-500/15",
		textClass: "text-violet-600 dark:text-violet-400",
		borderClass: "border-violet-500/20",
	},
	structured_outputs: {
		icon: <HugeiconsIcon className="size-3" icon={CodeIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={CodeIcon} />,
		label: "Structured",
		shortLabel: "{}",
		description:
			"Supports structured output schema. The model can return data in a predefined JSON schema format, ensuring consistent output structure.",
		bgClass: "bg-emerald-500/10 dark:bg-emerald-500/15",
		textClass: "text-emerald-600 dark:text-emerald-400",
		borderClass: "border-emerald-500/20",
	},
	response_format: {
		icon: <HugeiconsIcon className="size-3" icon={BubbleChatIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={BubbleChatIcon} />,
		label: "JSON",
		shortLabel: "JS",
		description:
			"Supports JSON response format. The model can return responses in valid JSON format, useful for programmatic integration.",
		bgClass: "bg-teal-500/10 dark:bg-teal-500/15",
		textClass: "text-teal-600 dark:text-teal-400",
		borderClass: "border-teal-500/20",
	},
	web_search_options: {
		icon: <HugeiconsIcon className="size-3" icon={GlobeIcon} />,
		iconSm: <HugeiconsIcon className="size-2.5" icon={GlobeIcon} />,
		label: "Search",
		shortLabel: "WEB",
		description:
			"Supports web search capabilities. The model can search the internet to find current information and answer questions with up-to-date data.",
		bgClass: "bg-orange-500/10 dark:bg-orange-500/15",
		textClass: "text-orange-600 dark:text-orange-400",
		borderClass: "border-orange-500/20",
	},
};

export const FEATURE_PRIORITY = [
	"tools",
	"parallel_tool_calls",
	"reasoning",
	"structured_outputs",
	"web_search_options",
] as const;

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

export function getQuantizationLabel(endpoint: OpenRouterEndpoint): string | undefined {
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

export interface ChipChromeOptions {
	flat: boolean;
	isSmall: boolean;
	shouldShowLabel: boolean;
}

export function chipSizeKey(showLabel: boolean, flat: boolean, isSmall: boolean): number {
	// biome-ignore lint/suspicious/noBitwiseOperators: intentional bit packing for stable O(1) lookup key
	return (showLabel ? 4 : 0) | (flat ? 2 : 0) | (isSmall ? 1 : 0);
}

const CHIP_SIZE_CLASS_MAP: Record<number, string> = {
	[chipSizeKey(true, false, true)]: "px-1 py-0.5",
	[chipSizeKey(true, true, true)]: "px-1 py-0.5",
	[chipSizeKey(true, false, false)]: "px-1.5 py-0.5",
	[chipSizeKey(true, true, false)]: "px-1.5 py-0.5",
	[chipSizeKey(false, true, true)]: "h-4 w-4",
	[chipSizeKey(false, true, false)]: "h-5 w-5",
	[chipSizeKey(false, false, true)]: "h-4 w-4 p-0.5",
	[chipSizeKey(false, false, false)]: "h-5 w-5 p-0.5",
};

export function getChipSizeClass({ flat, isSmall, shouldShowLabel }: ChipChromeOptions): string {
	return CHIP_SIZE_CLASS_MAP[chipSizeKey(shouldShowLabel, flat, isSmall)] ?? "h-4 w-4";
}

export function getChipIcon(config: FeatureIconConfig, isSmall: boolean): React.ReactNode {
	return isSmall ? config.iconSm : config.icon;
}

export function getChipLabelClass(isSmall: boolean): string {
	return cn(
		"font-semibold uppercase tracking-wider",
		isSmall ? "text-[10px] sm:text-[8px]" : "text-[10px] sm:text-[9px]"
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
			bgClass: "bg-amber-500/10 dark:bg-amber-500/15",
			textClass: "text-amber-600 dark:text-amber-400",
			borderClass: "border-amber-500/20",
		},
	};
}

export function resolveParamFeature(
	param: string,
	supportedParamsSet: Set<string>
): FeatureIconConfig | null {
	if (!supportedParamsSet.has(param)) {
		return null;
	}
	return FEATURE_ICONS[param] ?? null;
}

export function appendSupportedParams(
	features: Array<{ key: string; config: FeatureIconConfig }>,
	supportedParamsSet: Set<string>,
	maxIcons: number
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
	maxIcons: number
): Array<{ key: string; config: FeatureIconConfig }> {
	const supportedParamsSet = new Set(endpoint.supported_parameters ?? []);
	const quantLabel = getQuantizationLabel(endpoint);
	const features: Array<{ key: string; config: FeatureIconConfig }> = [];

	if (quantLabel) {
		features.push(buildQuantizationFeature(quantLabel));
	}

	appendSupportedParams(features, supportedParamsSet, maxIcons);
	return features;
}

export const __endpoint_feature_icons_test_helpers__ = {
	getChipSizeClass,
	getChipIcon,
	getChipLabelClass,
	buildFeatures,
	buildQuantizationFeature,
	appendSupportedParams,
	resolveParamFeature,
	getQuantizationLabel,
	chipSizeKey,
};
