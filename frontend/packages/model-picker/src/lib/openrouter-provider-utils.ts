/**
 * OpenRouter Provider Routing Utilities
 *
 * OpenRouter supports routing requests to specific infrastructure providers
 * (e.g., DeepInfra, Together, Azure) that host the same model.
 */

export const OPENROUTER_PROVIDERS = [
	"anthropic",
	"openai",
	"google",
	"azure",
	"deepinfra",
	"together",
	"fireworks",
	"lepton",
	"mancer",
	"novita",
	"avian",
	"lambda",
	"mistral",
	"perplexity",
	"replicate",
	"cloudflare",
	"cohere",
	"groq",
	"hyperbolic",
	"inflection",
	"lynn",
	"parasail",
	"sf-compute",
	"xai",
] as const;

export type OpenRouterProvider = (typeof OPENROUTER_PROVIDERS)[number];

export interface ProviderInfo {
	description?: string;
	id: OpenRouterProvider;
	name: string;
}

export const PROVIDER_INFO: Record<OpenRouterProvider, ProviderInfo> = {
	anthropic: {
		id: "anthropic",
		name: "Anthropic",
		description: "Official Anthropic API",
	},
	openai: { id: "openai", name: "OpenAI", description: "Official OpenAI API" },
	google: { id: "google", name: "Google", description: "Google AI (Gemini)" },
	azure: { id: "azure", name: "Azure", description: "Microsoft Azure OpenAI" },
	deepinfra: {
		id: "deepinfra",
		name: "DeepInfra",
		description: "Fast inference provider",
	},
	together: { id: "together", name: "Together", description: "Together AI" },
	fireworks: {
		id: "fireworks",
		name: "Fireworks",
		description: "Fireworks AI",
	},
	lepton: { id: "lepton", name: "Lepton", description: "Lepton AI" },
	mancer: { id: "mancer", name: "Mancer", description: "Mancer AI" },
	novita: { id: "novita", name: "Novita", description: "Novita AI" },
	avian: { id: "avian", name: "Avian", description: "Avian AI" },
	lambda: { id: "lambda", name: "Lambda", description: "Lambda Labs" },
	mistral: { id: "mistral", name: "Mistral", description: "Mistral AI" },
	perplexity: {
		id: "perplexity",
		name: "Perplexity",
		description: "Perplexity AI",
	},
	replicate: { id: "replicate", name: "Replicate", description: "Replicate" },
	cloudflare: {
		id: "cloudflare",
		name: "Cloudflare",
		description: "Cloudflare Workers AI",
	},
	cohere: { id: "cohere", name: "Cohere", description: "Cohere AI" },
	groq: { id: "groq", name: "Groq", description: "Groq (fast inference)" },
	hyperbolic: {
		id: "hyperbolic",
		name: "Hyperbolic",
		description: "Hyperbolic AI",
	},
	inflection: {
		id: "inflection",
		name: "Inflection",
		description: "Inflection AI",
	},
	lynn: { id: "lynn", name: "Lynn", description: "Lynn AI" },
	parasail: { id: "parasail", name: "Parasail", description: "Parasail AI" },
	"sf-compute": {
		id: "sf-compute",
		name: "SF Compute",
		description: "SF Compute",
	},
	xai: { id: "xai", name: "xAI", description: "xAI (Grok)" },
};

export interface ProviderPreferences {
	allow_fallbacks?: boolean;
	data_collection?: "allow" | "deny";
	enforce_distillable_text?: boolean;
	ignore?: string[];
	max_price?: {
		prompt?: number;
		completion?: number;
		request?: number;
		image?: number;
	};
	only?: string[];
	order?: string[];
	quantizations?: Array<
		"int4" | "int8" | "fp4" | "fp6" | "fp8" | "fp16" | "bf16" | "fp32" | "unknown"
	>;
	require_parameters?: boolean;
	sort?: "price" | "throughput" | "latency";
	zdr?: boolean;
}

export const PROVIDER_SORT_OPTIONS = [
	{ value: undefined, label: "Default (load balanced)" },
	{ value: "price", label: "Lowest Price" },
	{ value: "throughput", label: "Highest Throughput" },
	{ value: "latency", label: "Lowest Latency" },
] as const;

export type ProviderSortOption = "price" | "throughput" | "latency" | undefined;

export function formatProviderName(provider: string): string {
	const info = PROVIDER_INFO[provider as OpenRouterProvider];
	if (info) {
		return info.name;
	}
	return provider
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function isKnownProvider(provider: string): provider is OpenRouterProvider {
	return OPENROUTER_PROVIDERS.includes(provider as OpenRouterProvider);
}

/**
 * Filterable parameters list — locally-defined since WinSTT doesn't have a
 * shared `FilterableParameter` type. Mirrors the event_manager source.
 */
export const FILTERABLE_PARAMETERS = [
	"tools",
	"reasoning",
	"include_reasoning",
	"parallel_tool_calls",
	"max_tokens",
	"response_format",
	"structured_outputs",
	"web_search_options",
	"verbosity",
] as const;

export type FilterableParameter = (typeof FILTERABLE_PARAMETERS)[number];

export interface ParameterInfo {
	description: string;
	id: FilterableParameter;
	label: string;
}

export const PARAMETER_INFO: Record<FilterableParameter, ParameterInfo> = {
	tools: {
		id: "tools",
		label: "Tools",
		description: "Supports function/tool calling",
	},
	reasoning: {
		id: "reasoning",
		label: "Reasoning",
		description: "Supports reasoning output",
	},
	include_reasoning: {
		id: "include_reasoning",
		label: "Include Reasoning",
		description: "Can include reasoning in response",
	},
	parallel_tool_calls: {
		id: "parallel_tool_calls",
		label: "Parallel Tools",
		description: "Supports parallel tool calls",
	},
	max_tokens: {
		id: "max_tokens",
		label: "Max Tokens",
		description: "Supports max_tokens parameter",
	},
	response_format: {
		id: "response_format",
		label: "Response Format",
		description: "Supports JSON response format",
	},
	verbosity: {
		id: "verbosity",
		label: "Verbosity",
		description: "Controls verbosity/length of responses",
	},
	structured_outputs: {
		id: "structured_outputs",
		label: "Structured Outputs",
		description: "Supports structured output schema",
	},
	web_search_options: {
		id: "web_search_options",
		label: "Web Search",
		description: "Supports web search capabilities",
	},
};
