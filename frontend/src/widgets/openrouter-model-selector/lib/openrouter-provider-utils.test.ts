import { describe, expect, test } from "bun:test";
import {
	FILTERABLE_PARAMETERS,
	formatProviderName,
	isKnownProvider,
	OPENROUTER_PROVIDERS,
	PARAMETER_INFO,
	PROVIDER_INFO,
	PROVIDER_SORT_OPTIONS,
} from "./openrouter-provider-utils";

describe("OPENROUTER_PROVIDERS", () => {
	test("contains expected canonical providers", () => {
		expect(OPENROUTER_PROVIDERS).toContain("anthropic");
		expect(OPENROUTER_PROVIDERS).toContain("openai");
		expect(OPENROUTER_PROVIDERS).toContain("deepinfra");
	});

	test("entries are unique", () => {
		expect(new Set(OPENROUTER_PROVIDERS).size).toBe(OPENROUTER_PROVIDERS.length);
	});
});

describe("PROVIDER_INFO", () => {
	test("has an entry for every provider", () => {
		for (const p of OPENROUTER_PROVIDERS) {
			expect(PROVIDER_INFO[p]).toBeDefined();
			expect(PROVIDER_INFO[p].name.length).toBeGreaterThan(0);
		}
	});

	// Lock in the exact `name` and `description` strings for every provider
	// so any StringLiteral mutation (→ "") is killed by an exact-equality
	// assertion. Test data is generated as a flat table to keep this concise.
	test.each([
		["anthropic", "Anthropic", "Official Anthropic API"],
		["openai", "OpenAI", "Official OpenAI API"],
		["google", "Google", "Google AI (Gemini)"],
		["azure", "Azure", "Microsoft Azure OpenAI"],
		["deepinfra", "DeepInfra", "Fast inference provider"],
		["together", "Together", "Together AI"],
		["fireworks", "Fireworks", "Fireworks AI"],
		["lepton", "Lepton", "Lepton AI"],
		["mancer", "Mancer", "Mancer AI"],
		["novita", "Novita", "Novita AI"],
		["avian", "Avian", "Avian AI"],
		["lambda", "Lambda", "Lambda Labs"],
		["mistral", "Mistral", "Mistral AI"],
		["perplexity", "Perplexity", "Perplexity AI"],
		["replicate", "Replicate", "Replicate"],
		["cloudflare", "Cloudflare", "Cloudflare Workers AI"],
		["cohere", "Cohere", "Cohere AI"],
		["groq", "Groq", "Groq (fast inference)"],
		["hyperbolic", "Hyperbolic", "Hyperbolic AI"],
		["inflection", "Inflection", "Inflection AI"],
		["lynn", "Lynn", "Lynn AI"],
		["parasail", "Parasail", "Parasail AI"],
		["sf-compute", "SF Compute", "SF Compute"],
		["xai", "xAI", "xAI (Grok)"],
	])('PROVIDER_INFO[%p] has exact name=%p and description=%p (kills StringLiteral → "" mutants)', (slug, name, description) => {
		const info = PROVIDER_INFO[slug as keyof typeof PROVIDER_INFO];
		expect(info.name).toBe(name);
		expect(info.description).toBe(description);
	});

	test('PROVIDER_INFO[id] matches the slug key (kills `id: ""` mutants)', () => {
		for (const p of OPENROUTER_PROVIDERS) {
			expect(PROVIDER_INFO[p].id).toBe(p);
		}
	});
});

describe("isKnownProvider", () => {
	test("returns true for every advertised provider", () => {
		for (const p of OPENROUTER_PROVIDERS) {
			expect(isKnownProvider(p)).toBe(true);
		}
	});

	test("returns false for unknown providers", () => {
		expect(isKnownProvider("unknown-provider")).toBe(false);
		expect(isKnownProvider("")).toBe(false);
	});
});

describe("formatProviderName", () => {
	test("returns the canonical display name for a known provider", () => {
		expect(formatProviderName("anthropic")).toBe("Anthropic");
		expect(formatProviderName("xai")).toBe("xAI");
	});

	test("title-cases hyphenated unknown slugs", () => {
		expect(formatProviderName("acme-corp")).toBe("Acme Corp");
	});

	test("title-cases a single-word unknown slug", () => {
		expect(formatProviderName("foo")).toBe("Foo");
	});
});

describe("PROVIDER_SORT_OPTIONS", () => {
	test("includes the default (load-balanced) option with undefined value", () => {
		const def = PROVIDER_SORT_OPTIONS.find((o) => o.value === undefined);
		expect(def).toBeDefined();
	});

	test("price/throughput/latency options are present", () => {
		const values = PROVIDER_SORT_OPTIONS.map((o) => o.value);
		expect(values).toContain("price");
		expect(values).toContain("throughput");
		expect(values).toContain("latency");
	});
});

describe("FILTERABLE_PARAMETERS / PARAMETER_INFO", () => {
	test("every filterable parameter has a matching info entry", () => {
		for (const p of FILTERABLE_PARAMETERS) {
			expect(PARAMETER_INFO[p]).toBeDefined();
			expect(PARAMETER_INFO[p].label.length).toBeGreaterThan(0);
		}
	});

	test.each([
		["tools", "Tools", "Supports function/tool calling"],
		["reasoning", "Reasoning", "Supports reasoning output"],
		["include_reasoning", "Include Reasoning", "Can include reasoning in response"],
		["parallel_tool_calls", "Parallel Tools", "Supports parallel tool calls"],
		["max_tokens", "Max Tokens", "Supports max_tokens parameter"],
		["response_format", "Response Format", "Supports JSON response format"],
		["verbosity", "Verbosity", "Controls verbosity/length of responses"],
		["structured_outputs", "Structured Outputs", "Supports structured output schema"],
		["web_search_options", "Web Search", "Supports web search capabilities"],
	])('PARAMETER_INFO[%p] has exact label=%p and description=%p (kills StringLiteral → "" mutants)', (slug, label, description) => {
		const info = PARAMETER_INFO[slug as keyof typeof PARAMETER_INFO];
		expect(info.label).toBe(label);
		expect(info.description).toBe(description);
	});

	test('PARAMETER_INFO[id] matches the slug key (kills `id: ""` mutants)', () => {
		for (const p of FILTERABLE_PARAMETERS) {
			expect(PARAMETER_INFO[p].id).toBe(p);
		}
	});
});
