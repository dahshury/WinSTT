import {
	type AppSettingsOutput,
	appSettingsSchema,
} from "@/shared/config/settings-schema";

/**
 * Default settings derived from the Zod schema. Single source of truth
 * for all default values — no manual duplication.
 */
export const DEFAULT_SETTINGS: AppSettingsOutput = appSettingsSchema.parse({});
