import {
	Coins01Icon,
	Layers01Icon,
	ServerStack01Icon,
	SparklesIcon,
	Tag01Icon,
	Target01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import type { OpenRouterEndpoint, OpenRouterPricing } from "@/shared/api/models";
import { MODEL_VARIANT_INFO, type ModelVariant } from "./model-variant-utils";

const PRICE_FORMATTER = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
});

function formatCurrency(value: number): string {
	return PRICE_FORMATTER.format(value);
}

export function getVariantIcon(variant: ModelVariant, className = "h-3 w-3"): React.ReactNode {
	const iconClass = className;
	switch (variant) {
		case "free":
			return <HugeiconsIcon className={iconClass} icon={Tag01Icon} />;
		case "nitro":
			return <HugeiconsIcon className={iconClass} icon={ZapIcon} />;
		case "extended":
			return <HugeiconsIcon className={iconClass} icon={Layers01Icon} />;
		case "exacto":
			return <HugeiconsIcon className={iconClass} icon={Target01Icon} />;
		case "thinking":
			return <HugeiconsIcon className={iconClass} icon={SparklesIcon} />;
		case "online":
			return <HugeiconsIcon className={iconClass} icon={ServerStack01Icon} />;
		case "floor":
			return <HugeiconsIcon className={iconClass} icon={Coins01Icon} />;
		default:
			return null;
	}
}

export function getVariantClasses(variant: ModelVariant): {
	bg: string;
	text: string;
	border: string;
	gradient: string;
} {
	const info = MODEL_VARIANT_INFO[variant];
	return {
		bg: info.bgClass,
		text: info.textClass,
		border: info.borderClass,
		gradient: info.gradientClass,
	};
}

export function formatContextLength(contextLength: number): string {
	if (contextLength >= 1_000_000) {
		return `${(contextLength / 1_000_000).toFixed(1)}M`;
	}
	if (contextLength >= 1000) {
		return `${Math.round(contextLength / 1000)}K`;
	}
	return String(contextLength);
}

function parsePricingValue(raw: string | number | undefined): number {
	if (raw === undefined) {
		return 0;
	}
	if (typeof raw === "number") {
		return raw;
	}
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : 0;
}

export function getPricingTier(pricing: OpenRouterPricing | undefined): {
	label: string;
	tier: "free" | "low" | "medium" | "high";
	className: string;
} {
	const prompt = parsePricingValue(pricing?.prompt);
	const completion = parsePricingValue(pricing?.completion);

	const promptPerMillion = prompt * 1_000_000;
	const completionPerMillion = completion * 1_000_000;
	const avgCost = (promptPerMillion + completionPerMillion) / 2;

	if (prompt === 0 && completion === 0) {
		return {
			label: "Free",
			tier: "free",
			className: "text-emerald-600 dark:text-emerald-400",
		};
	}
	const formattedPrompt = formatCurrency(promptPerMillion);
	const formattedCompletion = formatCurrency(completionPerMillion);
	const priceLabel = `${formattedPrompt}/${formattedCompletion}`;

	if (avgCost < 1) {
		return {
			label: priceLabel,
			tier: "low",
			className: "text-green-600 dark:text-green-400",
		};
	}
	if (avgCost < 10) {
		return {
			label: priceLabel,
			tier: "medium",
			className: "text-amber-600 dark:text-amber-400",
		};
	}
	return {
		label: priceLabel,
		tier: "high",
		className: "text-rose-600 dark:text-rose-400",
	};
}

export function formatPricing(pricing: OpenRouterPricing | undefined): string {
	const prompt = parsePricingValue(pricing?.prompt);
	const completion = parsePricingValue(pricing?.completion);

	if (prompt === 0 && completion === 0) {
		return "Free";
	}

	const promptPerMillion = prompt * 1_000_000;
	const completionPerMillion = completion * 1_000_000;

	const formattedPrompt = formatCurrency(promptPerMillion);
	const formattedCompletion = formatCurrency(completionPerMillion);
	return `${formattedPrompt}/${formattedCompletion} per 1M`;
}

export function getUniqueEndpoints(endpoints: OpenRouterEndpoint[]): OpenRouterEndpoint[] {
	const seen = new Map<string, OpenRouterEndpoint>();
	for (const endpoint of endpoints) {
		if (!seen.has(endpoint.provider_name)) {
			seen.set(endpoint.provider_name, endpoint);
		}
	}
	return Array.from(seen.values());
}
