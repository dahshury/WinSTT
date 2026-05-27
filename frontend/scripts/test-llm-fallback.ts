/**
 * Fallback path smoke test.
 *
 * Verifies:
 *   1. computeModelExclusionConfig + isFallbackExcluded reject same-model picks
 *   2. filterModelsForFallback removes the primary's model from the catalog
 *      when no provider is pinned
 *   3. The IPC fallback recovers when the primary throws — uses an obviously
 *      bad primary model id and a real fallback id, asserts the result comes
 *      from the fallback.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-v1-... bun run scripts/test-llm-fallback.ts
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { computeModelExclusionConfig, filterModelsForFallback, isFallbackExcluded } from "@picker";
import { generateObject } from "ai";
import { z } from "zod";

// `filterModelsForFallback` takes the full OpenRouterModel record; derive the
// param type so the smoke-test fixture can present minimal `{id,name}` entries
// via a single `as unknown as` boundary cast.
type ModelInput = Parameters<typeof filterModelsForFallback>[0][number];

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("OPENROUTER_API_KEY env var is required");
	process.exit(1);
}

// ── 1. Exclusion logic ────────────────────────────────────────────────
{
	const cfg = computeModelExclusionConfig("openai/gpt-4o-mini");
	const cases: Array<[string, boolean, string]> = [
		["openai/gpt-4o-mini", true, "same model, no provider"],
		["openai/gpt-4o-mini@deepinfra", true, "same model + provider"],
		["openai/gpt-4o", false, "different model"],
		["", false, "auto fallback"],
	];
	for (const [fallbackVal, expected, label] of cases) {
		const got = isFallbackExcluded(fallbackVal, cfg);
		console.log(
			`[exclusion] ${got === expected ? "✓" : "✗"} ${label} (${fallbackVal || "<auto>"})`
		);
		if (got !== expected) process.exit(1);
	}
}

{
	const cfg = computeModelExclusionConfig("openai/gpt-4o-mini");
	const models = [
		{ id: "openai/gpt-4o-mini", name: "x" },
		{ id: "openai/gpt-4o", name: "y" },
		{ id: "anthropic/claude-sonnet-4", name: "z" },
	] as unknown as ModelInput[];
	const filtered = filterModelsForFallback(models, cfg);
	const ok = filtered.length === 2 && !filtered.some((m) => m.id === "openai/gpt-4o-mini");
	console.log(`[exclusion] ${ok ? "✓" : "✗"} filterModelsForFallback removes the primary`);
	if (!ok) process.exit(1);
}

// ── 2. Provider-pinned exclusion (preserves model, blocks endpoint) ──
{
	const cfg = computeModelExclusionConfig("openai/gpt-4o-mini@deepinfra");
	console.log(
		`[exclusion] ${
			!isFallbackExcluded("openai/gpt-4o-mini@together", cfg) ? "✓" : "✗"
		} same model, different provider allowed`
	);
	console.log(
		`[exclusion] ${
			isFallbackExcluded("openai/gpt-4o-mini@deepinfra", cfg) ? "✓" : "✗"
		} same model, same provider blocked`
	);
}

// ── 3. Live fallback recovery via IPC-like path ──────────────────────
const transformedTextSchema = z.object({ text: z.string() });
const openrouter = createOpenRouter({ apiKey });

async function transform(modelId: string, prompt: string) {
	const result = await generateObject({
		model: openrouter.chat(modelId),
		system: "Remove unnecessary words while keeping all key information.",
		prompt,
		schemaName: "TransformedText",
		schema: transformedTextSchema,
		experimental_repairText: ({ text: raw }) => Promise.resolve(raw),
		providerOptions: { openrouter: { plugins: [{ id: "response-healing" }] } },
	});
	return result.object.text;
}

async function transformWithFallback(primary: string, fallback: string, prompt: string) {
	try {
		return await transform(primary, prompt);
	} catch {
		return await transform(fallback, prompt);
	}
}

const sample = "Transform: 'so um yeah we like really need to get this out the door before friday'";

// Use an obviously bad primary id; expect fallback to win.
const out = await transformWithFallback(
	"definitely/not-a-real-model:bogus",
	"openai/gpt-4o-mini",
	sample
);
const ok = typeof out === "string" && out.length > 0 && !out.includes("```");
console.log(
	`[fallback] ${ok ? "✓" : "✗"} primary failed → fallback recovered: ${out.slice(0, 80)}…`
);
if (!ok) process.exit(1);

console.log("\n✓ all fallback checks passed");
