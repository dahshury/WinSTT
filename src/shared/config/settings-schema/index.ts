import { z } from "zod";
import { isPlainRecord } from "@/shared/lib/is-record";
import { audioSettingsSchema } from "./audio";
import {
	dictionaryEntrySchema,
	globalSettingsSchema,
	hotkeySettingsSchema,
	modelSettingsSchema,
	qualitySettingsSchema,
	snippetEntrySchema,
} from "./core";
import { generalSettingsSchema } from "./general";
import { llmSettingsSchema } from "./llm";
import { integrationsSchema, ttsSettingsSchema } from "./tts";

export * from "./audio";
export * from "./core";
export * from "./general";
export * from "./llm";
export * from "./secrets";
export * from "./tts";

function objectRecord(value: unknown): Record<string, unknown> | null {
	return isPlainRecord(value) ? value : null;
}

function migrateLegacyGlobalSettings(payload: unknown): unknown {
	const root = objectRecord(payload);
	if (!root) {
		return payload;
	}
	const model = objectRecord(root["model"]);
	const legacyTimeout = model?.["modelUnloadTimeout"];
	if (legacyTimeout === undefined) {
		return payload;
	}
	const global = objectRecord(root["global"]);
	if (global?.["modelUnloadTimeout"] !== undefined) {
		return payload;
	}
	return {
		...root,
		global: {
			...(global ?? {}),
			modelUnloadTimeout: legacyTimeout,
		},
	};
}

// OpenAI was removed as a direct cloud STT provider. A persisted
// `model.model = "openai:<id>"` selection is rewritten to the equivalent
// OpenRouter route (`openrouter:openai/<id>`), so an existing OpenAI cloud
// transcription selection keeps working (via the OpenRouter key) instead of
// silently reverting to a local model.
function migrateOpenaiSttModel(payload: unknown): unknown {
	const root = objectRecord(payload);
	if (!root) {
		return payload;
	}
	const model = objectRecord(root["model"]);
	const id = model?.["model"];
	if (typeof id !== "string" || !id.startsWith("openai:")) {
		return payload;
	}
	const bareId = id.slice("openai:".length);
	return {
		...root,
		model: { ...model, model: `openrouter:openai/${bareId}` },
	};
}

/**
 * Apply every pre-parse legacy migration in one pass. Single-sourced so the
 * whole-tree `appSettingsSchema` preprocess AND the per-section recovery path
 * in `settings-codec.partialDecodeBySections` run the SAME migrations — the
 * per-section path previously bypassed `migrateOpenaiSttModel`, so a corrupt
 * unrelated section could drop the OpenAI→OpenRouter STT rewrite and silently
 * revert a cloud transcription selection to a local model.
 */
export function migrateLegacySettings(payload: unknown): unknown {
	return migrateOpenaiSttModel(migrateLegacyGlobalSettings(payload));
}

/**
 * Settings schema version (finding #20). Bumped when a breaking shape change
 * needs a migration step. The Rust backend persists it as the `schemaVersion`
 * field of `WinsttSettings` (so a downgrade/upgrade is detectable) and the zod
 * schema parses the same field below, so both sides carry one shared anchor for
 * future migrations. Must equal the Rust `SCHEMA_VERSION` — the defaults-parity
 * fixture (which includes `schemaVersion`) fails CI when they drift.
 */
const SETTINGS_SCHEMA_VERSION = 1;

const appSettingsBaseSchema = z.object({
	// The one top-level SCALAR in an otherwise all-object tree. Section-generic
	// helpers (`patchSection`, per-section merges) must not treat it as a
	// patchable section — see `ObjectSectionKey` in entities/setting.
	schemaVersion: z
		.number()
		.int()
		.default(SETTINGS_SCHEMA_VERSION)
		.catch(SETTINGS_SCHEMA_VERSION),
	global: globalSettingsSchema.prefault({}),
	model: modelSettingsSchema.prefault({}),
	quality: qualitySettingsSchema.prefault({}),
	audio: audioSettingsSchema.prefault({}),
	general: generalSettingsSchema.prefault({}),
	hotkey: hotkeySettingsSchema.prefault({}),
	// `.catch([])` is the migration safety net for persisted entries from the
	// pre-v10 shape (find/replace/caseSensitive/wholeWord) will fail the new
	// `term`-only parser and bring the whole array with it. The catch maps
	// the failure to an empty array, matching the agreed-upon wipe semantics.
	dictionary: z.array(dictionaryEntrySchema).default([]).catch([]),
	snippets: z.array(snippetEntrySchema).default([]),
	llm: llmSettingsSchema.prefault({}),
	tts: ttsSettingsSchema.prefault({}),
	integrations: integrationsSchema.prefault({}),
});

export const appSettingsSectionSchemas = appSettingsBaseSchema.shape;

export const appSettingsSchema = z.preprocess(
	(payload) => migrateLegacySettings(payload),
	appSettingsBaseSchema,
);

export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
