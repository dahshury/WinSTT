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
export * from "./tts";

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function migrateLegacyGlobalSettings(payload: unknown): unknown {
  const root = objectRecord(payload);
  if (!root) {
    return payload;
  }
  const model = objectRecord(root.model);
  const legacyTimeout = model?.modelUnloadTimeout;
  if (legacyTimeout === undefined) {
    return payload;
  }
  const global = objectRecord(root.global);
  if (global?.modelUnloadTimeout !== undefined) {
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

const appSettingsBaseSchema = z.object({
  global: globalSettingsSchema.prefault({}),
  model: modelSettingsSchema.prefault({}),
  quality: qualitySettingsSchema.prefault({}),
  audio: audioSettingsSchema.prefault({}),
  general: generalSettingsSchema.prefault({}),
  hotkey: hotkeySettingsSchema.prefault({}),
  // `.catch([])` is the migration safety net: any persisted entry from the
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
  migrateLegacyGlobalSettings,
  appSettingsBaseSchema,
);

export type AppSettingsOutput = z.output<typeof appSettingsSchema>;
