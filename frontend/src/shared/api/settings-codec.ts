import { type AppSettingsOutput, appSettingsSchema } from "@/shared/config/settings-schema";

export function decodeSettingsPayload(payload: unknown): AppSettingsOutput {
	const parsed = appSettingsSchema.safeParse(payload);
	if (parsed.success) {
		return parsed.data;
	}
	// Fallback: use safeParse to avoid throwing at a boundary
	const fallback = appSettingsSchema.safeParse({});
	if (fallback.success) {
		return fallback.data;
	}
	// Schema defaults should always parse; this is a defensive last resort
	throw new Error(`Settings schema failed to produce defaults: ${fallback.error.message}`);
}
