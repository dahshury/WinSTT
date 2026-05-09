/**
 * Debug: try generateObject with OpenRouter response_healing plugin enabled.
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("OPENROUTER_API_KEY required");
	process.exit(1);
}

const openrouter = createOpenRouter({ apiKey });

async function viaGenerateObject(modelId: string) {
	try {
		const r = await generateObject({
			model: openrouter.chat(modelId),
			system: "Remove unnecessary words while keeping all key information.",
			prompt:
				"Transform: 'so um yeah we like really need to get this out the door before friday'. Return ONLY the transformed text in the `text` field.",
			schemaName: "TransformedText",
			schemaDescription: "The transformed text only.",
			schema: z.object({ text: z.string() }),
			experimental_repairText: async ({ text, error }) => {
				console.log(
					`  [repairText] error=${error.constructor.name} text=${JSON.stringify(text).slice(0, 200)}`
				);
				const trimmed = text
					.trim()
					.replace(/^```(?:json)?\s*/i, "")
					.replace(/\s*```$/i, "");
				try {
					JSON.parse(trimmed);
					return trimmed;
				} catch {
					return `{"text": ${JSON.stringify(trimmed.replace(/^["']|["']$/g, ""))}}`;
				}
			},
			providerOptions: {
				openrouter: {
					plugins: [{ id: "response-healing" }],
				},
			},
		});
		return { ok: true, object: r.object };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

const targets = ["anthropic/claude-sonnet-4", "anthropic/claude-3.5-sonnet", "openai/gpt-4o-mini"];

for (const t of targets) {
	console.log(`\n=== ${t} ===`);
	console.log(JSON.stringify(await viaGenerateObject(t), null, 2));
}
