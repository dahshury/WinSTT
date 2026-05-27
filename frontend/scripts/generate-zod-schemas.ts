/**
 * Generates Zod schemas for every string-enum defined in spec/openapi.yaml.
 *
 * `openapi-typescript` already produces compile-time TS literal unions in
 * spec/generated/ts/schema.d.ts, but Zod needs runtime values. Hand-writing a
 * z.enum next to each consumer creates a drift hazard (the picker bug that
 * silently dropped moonshine/cohere rows was exactly that). This script
 * reads the same spec and emits a sibling schema.zod.ts so the runtime
 * validator and the compile-time type share one source.
 *
 * Run via `bun generate` (chained after openapi-typescript). Standalone:
 *   bun run scripts/generate-zod-schemas.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

interface OpenApiSchema {
	enum?: unknown[];
	type?: string;
}

interface OpenApiDocument {
	components?: {
		schemas?: Record<string, OpenApiSchema>;
	};
}

const SPEC_PATH = resolve(import.meta.dir, "..", "..", "spec", "openapi.yaml");
const OUT_PATH = resolve(import.meta.dir, "..", "src", "shared", "api", "schema.zod.ts");

const doc = parse(readFileSync(SPEC_PATH, "utf8")) as OpenApiDocument;
const schemas = doc.components?.schemas ?? {};

const blocks: string[] = [];
for (const [name, schema] of Object.entries(schemas)) {
	if (schema.type !== "string" || !Array.isArray(schema.enum)) {
		continue;
	}
	const values = schema.enum.filter((v): v is string => typeof v === "string");
	if (values.length === 0) {
		continue;
	}
	const literals = values.map((v) => JSON.stringify(v)).join(", ");
	blocks.push(
		`export const ${name}Schema = z.enum([${literals}]);\nexport type ${name} = z.infer<typeof ${name}Schema>;`
	);
}

const header = `/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: spec/openapi.yaml (string enums under components.schemas).
 * Regenerate via \`bun generate\`.
 */

import { z } from "zod";
`;

writeFileSync(OUT_PATH, `${header}\n${blocks.join("\n\n")}\n`, "utf8");
console.log(`Wrote ${blocks.length} Zod enum schemas → ${OUT_PATH}`);
