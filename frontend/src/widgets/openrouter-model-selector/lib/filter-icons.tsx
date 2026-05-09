import {
	BubbleChatIcon,
	CodeIcon,
	FilterIcon,
	Layers01Icon,
	ServerStack01Icon,
	Settings01Icon,
	SparklesIcon,
	Tag01Icon,
	Target01Icon,
	Wrench01Icon,
	ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { ModelVariant } from "./model-variant-utils";
import type { FilterableParameter } from "./openrouter-provider-utils";

type IconDef = typeof FilterIcon;

const VARIANT_ICON_MAP: Record<ModelVariant | "none", IconDef> = {
	free: Tag01Icon,
	floor: Tag01Icon,
	nitro: ZapIcon,
	extended: Layers01Icon,
	exacto: Target01Icon,
	thinking: SparklesIcon,
	online: ServerStack01Icon,
	none: FilterIcon,
};

const PARAMETER_ICON_MAP: Record<string, IconDef> = {
	tools: Wrench01Icon,
	reasoning: SparklesIcon,
	include_reasoning: SparklesIcon,
	parallel_tool_calls: Layers01Icon,
	max_tokens: BubbleChatIcon,
	verbosity: BubbleChatIcon,
	response_format: CodeIcon,
	structured_outputs: CodeIcon,
	web_search_options: ServerStack01Icon,
};

function renderIcon(icon: IconDef): ReactNode {
	return <HugeiconsIcon className="size-4" icon={icon} />;
}

export function getVariantIcon(variant: ModelVariant | "none"): ReactNode {
	const icon = VARIANT_ICON_MAP[variant] ?? FilterIcon;
	return renderIcon(icon);
}

export function getParameterIcon(param: FilterableParameter): ReactNode {
	const icon = PARAMETER_ICON_MAP[param] ?? Settings01Icon;
	return renderIcon(icon);
}

export const __filter_icons_test_helpers__ = {
	VARIANT_ICON_MAP,
	PARAMETER_ICON_MAP,
	renderIcon,
};
