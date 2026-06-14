/**
 * Generates the cloud-STT transcription model catalog from the AI SDK's OWN
 * internal model-id unions, so the picker follows exactly what the installed
 * `@ai-sdk/*` providers can drive — no `/v1/models` scraping, no capability
 * heuristic, and no realtime ids (the AI SDK's transcription unions already
 * exclude them).
 *
 * Sources:
 *   - `@ai-sdk/openai`     → `OpenAITranscriptionModelId`
 *   - `@ai-sdk/elevenlabs` → `ElevenLabsTranscriptionModelId`
 *
 * Both are TS literal unions like `'whisper-1' | 'gpt-4o-transcribe' | (string
 * & {})`. We extract the quoted literals (the `(string & {})` escape hatch is
 * unquoted, so it's naturally skipped) and emit
 * `src/entities/cloud-stt-provider/model/cloud-models.generated.ts`.
 *
 * OpenAI is then filtered to the ids the AI SDK can ACTUALLY transcribe: its
 * implementation sends `response_format=json` for a hardcoded set and
 * `verbose_json` for the rest — which only `whisper-1` accepts (the dated
 * `gpt-4o-*` snapshots + `-diarize` 400 on `verbose_json`). See
 * `extractOpenAiJsonFormatIds`.
 *
 * The output is committed so builds don't depend on regeneration. The AI SDK
 * packages are NOT runtime dependencies of this app (cloud calls go through the
 * Rust `genai` backend), so they are not kept installed. To regenerate after a
 * provider adds models, temporarily install them and run the script:
 *
 *   bun add -d @ai-sdk/openai @ai-sdk/elevenlabs
 *   bun run tools/generate-cloud-models.ts
 *   bun remove @ai-sdk/openai @ai-sdk/elevenlabs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

interface Source {
	dtsPath: string;
	provider: "openai" | "elevenlabs";
	typeName: string;
}

const SOURCES: Source[] = [
	{
		provider: "openai",
		typeName: "OpenAITranscriptionModelId",
		dtsPath: resolve(ROOT, "node_modules/@ai-sdk/openai/dist/index.d.ts"),
	},
	{
		provider: "elevenlabs",
		typeName: "ElevenLabsTranscriptionModelId",
		dtsPath: resolve(ROOT, "node_modules/@ai-sdk/elevenlabs/dist/index.d.ts"),
	},
];

const OPENAI_JS_PATH = resolve(ROOT, "node_modules/@ai-sdk/openai/dist/index.js");

/** Pull the single-quoted string literals out of a `type X = '...' | '...' | (string & {});` union. */
function extractUnionLiterals(dts: string, typeName: string): string[] {
	const declaration = new RegExp(`type\\s+${typeName}\\s*=\\s*([^;]+);`).exec(dts);
	if (declaration === null || declaration[1] === undefined) {
		throw new Error(
			`generate-cloud-models: could not find \`type ${typeName}\` — did the @ai-sdk package layout change?`
		);
	}
	const literals = [...declaration[1].matchAll(/'([^']+)'/g)]
		.map((m) => m[1])
		.filter((id): id is string => id !== undefined);
	if (literals.length === 0) {
		throw new Error(`generate-cloud-models: \`${typeName}\` yielded no string literals.`);
	}
	return literals;
}

/**
 * The OpenAI transcription union lists ids the AI SDK CAN'T actually transcribe:
 * its model implementation hardcodes `response_format=json` for a fixed set and
 * sends `verbose_json` for everything else — but only `whisper-1` accepts
 * `verbose_json` (the dated `gpt-4o-*-transcribe-YYYY-MM-DD` snapshots and
 * `gpt-4o-transcribe-diarize` 400 with "response_format 'verbose_json' is not
 * compatible"). So we keep ONLY the ids the AI SDK sends `json` for, plus
 * whisper. Source line in `@ai-sdk/openai/dist/index.js`:
 *   response_format: ["gpt-4o-transcribe","gpt-4o-mini-transcribe"].includes(this.modelId) ? "json" : "verbose_json"
 */
function extractOpenAiJsonFormatIds(js: string): Set<string> {
	const match = /response_format:\s*\[([\s\S]*?)\]\s*\.includes\(this\.modelId\)/.exec(js);
	if (match === null || match[1] === undefined) {
		throw new Error(
			"generate-cloud-models: could not find the OpenAI response_format json list in @ai-sdk/openai/dist/index.js — did its transcription implementation change?"
		);
	}
	const ids = [...match[1].matchAll(/"([^"]+)"/g)]
		.map((m) => m[1])
		.filter((id): id is string => id !== undefined);
	if (ids.length === 0) {
		throw new Error("generate-cloud-models: the OpenAI response_format json list was empty.");
	}
	return new Set(ids);
}

function buildIdMap(): Record<"openai" | "elevenlabs", string[]> {
	const out: Record<"openai" | "elevenlabs", string[]> = { openai: [], elevenlabs: [] };
	for (const { provider, typeName, dtsPath } of SOURCES) {
		const dts = readFileSync(dtsPath, "utf8");
		out[provider] = extractUnionLiterals(dts, typeName);
	}
	// Drop OpenAI ids the AI SDK would transcribe with an incompatible
	// response_format (see extractOpenAiJsonFormatIds).
	const jsonIds = extractOpenAiJsonFormatIds(readFileSync(OPENAI_JS_PATH, "utf8"));
	out.openai = out.openai.filter((id) => jsonIds.has(id) || /^whisper/i.test(id));
	return out;
}

function renderFile(ids: Record<"openai" | "elevenlabs", string[]>): string {
	const fmt = (list: string[]) => list.map((id) => `\t\t"${id}",`).join("\n");
	return `// AUTO-GENERATED by tools/generate-cloud-models.ts — DO NOT EDIT.
//
// Mirrors the AI SDK's internal transcription model-id unions so the cloud
// picker offers exactly what the installed providers can drive:
//   @ai-sdk/openai      → OpenAITranscriptionModelId
//   @ai-sdk/elevenlabs  → ElevenLabsTranscriptionModelId
//
// Re-run \`bun run tools/generate-cloud-models.ts\` after bumping the @ai-sdk packages.

export const GENERATED_CLOUD_MODEL_IDS = {
	openai: [
${fmt(ids.openai)}
	],
	elevenlabs: [
${fmt(ids.elevenlabs)}
	],
} as const;
`;
}

function main(): void {
	const ids = buildIdMap();
	const outPath = resolve(ROOT, "src/entities/cloud-stt-provider/model/cloud-models.generated.ts");
	writeFileSync(outPath, renderFile(ids), "utf8");
	const total = ids.openai.length + ids.elevenlabs.length;
	console.log(
		`Wrote ${total} cloud model ids (${ids.openai.length} openai, ${ids.elevenlabs.length} elevenlabs) → ${outPath}`
	);
}

main();
