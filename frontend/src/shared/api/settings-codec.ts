import { type AppSettingsOutput, appSettingsSchema } from "@/shared/config/settings-schema";
import { resolveHotkeyTriple } from "@/shared/lib/hotkey-conflict";

/**
 * Normalize the three globally-registered hotkeys so no pair is in a
 * subset / superset / equal relationship. Defense in depth: the recorder UI
 * already blocks conflicts at capture time, but settings.json can be edited
 * out-of-band (manual edit, sync conflict, older app version), and the
 * runtime registrars would silently double-fire on the colliding combos.
 *
 * Policy is defined by `resolveHotkeyTriple`: PTT wins; the other two reset
 * to their schema defaults when they collide. The defaults themselves are
 * pulled from a fresh `appSettingsSchema.parse({})` so this stays a single
 * source of truth — no duplicated literal strings to drift.
 */
function hotkeyTripleUnchanged(
	values: { pushToTalkKey: string; repasteHotkey: string; ttsHotkey: string },
	parsed: AppSettingsOutput
): boolean {
	return (
		values.pushToTalkKey === parsed.hotkey.pushToTalkKey &&
		values.repasteHotkey === parsed.general.repasteHotkey &&
		values.ttsHotkey === parsed.tts.hotkey
	);
}

function normalizeHotkeys(parsed: AppSettingsOutput): AppSettingsOutput {
	const defaults = appSettingsSchema.parse({});
	const { values } = resolveHotkeyTriple(
		{
			pushToTalkKey: parsed.hotkey.pushToTalkKey,
			repasteHotkey: parsed.general.repasteHotkey,
			ttsHotkey: parsed.tts.hotkey,
		},
		{
			pushToTalkKey: defaults.hotkey.pushToTalkKey,
			repasteHotkey: defaults.general.repasteHotkey,
			ttsHotkey: defaults.tts.hotkey,
		}
	);
	// Preserve referential equality downstream (Zustand selector memoization,
	// React Compiler) when nothing actually changed.
	if (hotkeyTripleUnchanged(values, parsed)) {
		return parsed;
	}
	return {
		...parsed,
		hotkey: { ...parsed.hotkey, pushToTalkKey: values.pushToTalkKey },
		general: { ...parsed.general, repasteHotkey: values.repasteHotkey },
		tts: { ...parsed.tts, hotkey: values.ttsHotkey },
	};
}

export function decodeSettingsPayload(payload: unknown): AppSettingsOutput {
	const parsed = appSettingsSchema.safeParse(payload);
	if (parsed.success) {
		return normalizeHotkeys(parsed.data);
	}
	// Fall back to schema defaults. `parse({})` throws if the schema can't
	// produce defaults — that's a programming error in the schema, not a
	// runtime concern, so propagating the throw is correct. The defaults are
	// definitionally non-conflicting, so no normalization pass is needed.
	return appSettingsSchema.parse({});
}
