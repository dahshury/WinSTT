/**
 * End-to-end smoke test for the LLM IPC layer.
 *
 * Mirrors the exact code path in electron/ipc/llm.ts (generateObject + Zod
 * schema + OpenRouter response_healing plugin + experimental_repairText).
 * Verifies model-selection encoding, OpenRouter /api/v1/models scan, and the
 * full transform pipeline across all 6 presets and a representative model
 * from each major provider.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-v1-... bun run scripts/test-llm-e2e.ts [modelId]
 */
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";
import {
	ALL_PRESET_KEYS,
	getPresetPrompt,
	PRESET_LEVELS,
	PRESETS_WITH_LEVELS,
	type PresetKey,
	type PresetLevel,
} from "../src/entities/llm-catalog/lib/preset-prompts";
import {
	createModelSelection,
	parseModelSelection,
} from "../src/shared/lib/openrouter-model-selection";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
	console.error("OPENROUTER_API_KEY env var is required");
	process.exit(1);
}

// ── 1. Model-selection encoding round-trip ────────────────────────────
{
	const cases: Array<[string, string, string?]> = [
		["openai/gpt-4o-mini", "openai/gpt-4o-mini"],
		["openai/gpt-4o", "openai/gpt-4o@deepinfra", "deepinfra"],
		["", ""],
	];
	for (const [modelId, encoded, providerSlug] of cases) {
		const built = createModelSelection(modelId, providerSlug);
		const parsed = parseModelSelection(encoded);
		const ok =
			built === encoded &&
			parsed.modelId === modelId &&
			(parsed.providerSlug ?? undefined) === providerSlug;
		console.log(`[selection] ${ok ? "✓" : "✗"} ${encoded}`);
		if (!ok) process.exit(1);
	}
}

// ── 2. OpenRouter /api/v1/models scan ─────────────────────────────────
{
	const res = await fetch("https://openrouter.ai/api/v1/models", {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!res.ok) {
		console.error("[models] HTTP", res.status);
		process.exit(1);
	}
	const json = (await res.json()) as { data?: Array<{ id: string }> };
	const count = json.data?.length ?? 0;
	console.log(`[models] ✓ ${count} models from /api/v1/models`);
	if (count < 50) process.exit(1);
}

// ── 3. processWithOpenRouter() — exact IPC path ──────────────────────
const transformedTextSchema = z.object({
	text: z.string().describe("The transformed text, with no commentary or explanations."),
});

async function transform(text: string, preset: PresetKey, modelId: string, level?: PresetLevel) {
	const openrouter = createOpenRouter({
		apiKey,
		headers: {
			"HTTP-Referer": "https://github.com/dahshury/winstt",
			"X-Title": "WinSTT (e2e test)",
		},
	});
	const model = openrouter.chat(modelId);
	const userPrompt = `Transform the following text according to the style guide above. Return ONLY the transformed text. No commentary, no explanations, no JSON keys other than \`text\`.\n\nText to transform:\n${text}`;
	const result = await generateObject({
		model,
		system: getPresetPrompt(preset, level),
		prompt: userPrompt,
		schemaName: "TransformedText",
		schemaDescription: "The transformed text only.",
		schema: transformedTextSchema,
		experimental_repairText: async ({ text: raw }) => {
			const stripped = raw
				.trim()
				.replace(/^```(?:json)?\s*/i, "")
				.replace(/\s*```$/i, "")
				.trim();
			try {
				JSON.parse(stripped);
				return stripped;
			} catch {
				const inner = stripped.replace(/^["']|["']$/g, "");
				return JSON.stringify({ text: inner });
			}
		},
		providerOptions: {
			openrouter: {
				plugins: [{ id: "response-healing" }],
			},
		},
	});
	return result.object.text.trim();
}

const sample =
	"so um yeah we like really need to get this out the door before friday otherwise the whole release is just gonna slip again";

const targets = process.argv[2]
	? [process.argv[2]]
	: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4", "google/gemini-2.0-flash-001"];

interface PresetCase {
	key: PresetKey;
	label: string;
	level?: PresetLevel;
}

const leveledKeys = new Set<PresetKey>(PRESETS_WITH_LEVELS as readonly PresetKey[]);
const presetCases: PresetCase[] = ALL_PRESET_KEYS.flatMap((key): PresetCase[] => {
	if (leveledKeys.has(key)) {
		return PRESET_LEVELS.map((level) => ({ key, level, label: `${key}:${level}` }));
	}
	return [{ key, label: key }];
});

let failures = 0;
for (const target of targets) {
	console.log(`\n--- ${target} ---`);
	for (const c of presetCases) {
		try {
			const out = await transform(sample, c.key, target, c.level);
			const ok = typeof out === "string" && out.length > 0 && !out.includes("```");
			console.log(
				`[${c.label}] ${ok ? "✓" : "✗"} ${out.slice(0, 80)}${out.length > 80 ? "…" : ""}`
			);
			if (!ok) failures += 1;
		} catch (err) {
			console.error(`[${c.label}] ✗ ${(err as Error).message}`);
			failures += 1;
		}
	}
}

if (failures > 0) {
	console.error(`\n${failures} preset(s) failed`);
	process.exit(1);
}
console.log("\n✓ all checks passed");
