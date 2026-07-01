/**
 * OpenRouter Provider Routing Utilities
 *
 * OpenRouter supports routing requests to specific infrastructure providers
 * (e.g., DeepInfra, Together, Azure) that host the same model.
 */

const OPENROUTER_PROVIDERS = [
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

type OpenRouterProvider = (typeof OPENROUTER_PROVIDERS)[number];

const PROVIDER_NAMES: Record<OpenRouterProvider, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	google: "Google",
	azure: "Azure",
	deepinfra: "DeepInfra",
	together: "Together",
	fireworks: "Fireworks",
	lepton: "Lepton",
	mancer: "Mancer",
	novita: "Novita",
	avian: "Avian",
	lambda: "Lambda",
	mistral: "Mistral",
	perplexity: "Perplexity",
	replicate: "Replicate",
	cloudflare: "Cloudflare",
	cohere: "Cohere",
	groq: "Groq",
	hyperbolic: "Hyperbolic",
	inflection: "Inflection",
	lynn: "Lynn",
	parasail: "Parasail",
	"sf-compute": "SF Compute",
	xai: "xAI",
};

export function formatProviderName(provider: string): string {
	const name = PROVIDER_NAMES[provider as OpenRouterProvider];
	if (name) {
		return name;
	}
	return provider
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
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

export const PARAMETER_INFO: Record<FilterableParameter, { label: string }> = {
	tools: { label: "Tools" },
	reasoning: { label: "Reasoning" },
	include_reasoning: { label: "Include Reasoning" },
	parallel_tool_calls: { label: "Parallel Tools" },
	max_tokens: { label: "Max Tokens" },
	response_format: { label: "Response Format" },
	verbosity: { label: "Verbosity" },
	structured_outputs: { label: "Structured Outputs" },
	web_search_options: { label: "Web Search" },
};
