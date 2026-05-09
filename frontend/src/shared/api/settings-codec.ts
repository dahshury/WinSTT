import { type AppSettingsOutput, appSettingsSchema } from "@/shared/config/settings-schema";

export function decodeSettingsPayload(payload: unknown): AppSettingsOutput {
	const parsed = appSettingsSchema.safeParse(payload);
	if (parsed.success) {
		return parsed.data;
	}
	// Fall back to schema defaults. `parse({})` throws if the schema can't
	// produce defaults — that's a programming error in the schema, not a
	// runtime concern, so propagating the throw is correct.
	return appSettingsSchema.parse({});
}
