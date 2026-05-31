/**
 * One-shot smoke test for AI SDK + OpenRouter + Output.object structured output.
 *
 * Run with:
 *   OPENROUTER_API_KEY=sk-or-v1-... bun run scripts/test-openrouter.ts
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { z } from "zod";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("OPENROUTER_API_KEY env var is required");
	process.exit(1);
}

const openrouter = createOpenRouter({
	apiKey,
	headers: {
		"HTTP-Referer": "https://github.com/dahshury/winstt",
		"X-Title": "WinSTT (smoke test)",
	},
});

const transformedTextSchema = z.object({
	text: z.string().describe("The transformed text, with no commentary or explanations."),
});

const presets = {
	concise: "Remove unnecessary words while keeping all key information.",
	formal: "Convert to professional business English with formal tone.",
	friendly: "Make the text warm, conversational, and approachable.",
} as const;

const sample =
	"so um yeah we like really need to get this out the door before friday otherwise the whole release is just gonna slip again";

async function run(modelId: string, presetKey: keyof typeof presets) {
	const model = openrouter.chat(modelId);
	const result = await generateText({
		model,
		system: presets[presetKey],
		prompt: `Transform the following text according to the style guide above. Return ONLY the transformed text with no commentary.\n\nText to transform:\n${sample}`,
		output: Output.object({
			name: "TransformedText",
			description: "The transformed text only.",
			schema: transformedTextSchema,
		}),
	});
	const out = result.output.text;
	console.log(`\n[${modelId}][${presetKey}]`);
	console.log("input :", sample);
	console.log("output:", out);
}

const target = process.argv[2] ?? "openai/gpt-4o-mini";

await run(target, "concise");
await run(target, "formal");
await run(target, "friendly");
