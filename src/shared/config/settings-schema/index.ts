import { z } from "zod";
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

const appSettingsBaseSchema = z.object({
	global: globalSettingsSchema.prefault({}),
	model: modelSettingsSchema.prefault({}),
	quality: qualitySettingsSchema.prefault({}),
	audio: audioSettingsSchema.prefault({}),
	general: generalSettingsSchema.prefault({}),
	hotkey: hotkeySettingsSchema.prefault({}),
	dictionary: z.array(dictionaryEntrySchema).default([]).catch([]),
	// `.catch` matches `dictionary`: one malformed persisted snippet must reset
	// only this array, not fail the whole-tree parse into per-section recovery.
	snippets: z.array(snippetEntrySchema).default([]).catch([]),
	llm: llmSettingsSchema.prefault({}),
	tts: ttsSettingsSchema.prefault({}),
	integrations: integrationsSchema.prefault({}),
});

export const appSettingsSectionSchemas = appSettingsBaseSchema.shape;

export const appSettingsSchema = appSettingsBaseSchema;

export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
