import type { z } from "zod";
import {
	type AppSettingsOutput,
	appSettingsSchema,
	appSettingsSectionSchemas,
} from "@/shared/config/settings-schema";
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
	parsed: AppSettingsOutput,
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
		},
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

/**
 * Per-section recovery: when ``appSettingsSchema.safeParse`` rejects the
 * payload because ONE section (e.g. ``integrations``) is corrupt, parse
 * every other section independently so a single bad field can't drag the
 * whole settings tree down to defaults.
 *
 * Regression context: a main-process bug serialized
 * ``integrations.openai = ""`` (string) into the broadcast payload. The
 * old "fail → return parse({})" path silently reset ``model.model`` to the
 * schema default (``"tiny"``), producing the "switching never reaches the
 * main window" symptom because every other window's broadcast was being
 * clobbered with defaults. Per-section parsing here means even if a future
 * upstream bug corrupts ``integrations`` again, ``model`` survives.
 */
function payloadAsRecord(payload: unknown): Record<string, unknown> {
	return typeof payload === "object" && payload !== null
		? (payload as Record<string, unknown>)
		: {};
}

function migrateLegacyGlobalSection(payload: unknown): Record<string, unknown> {
	const root = payloadAsRecord(payload);
	const model = payloadAsRecord(root.model);
	const legacyTimeout = model.modelUnloadTimeout;
	if (legacyTimeout === undefined) {
		return root;
	}
	const global = payloadAsRecord(root.global);
	if (global.modelUnloadTimeout !== undefined) {
		return root;
	}
	return {
		...root,
		global: {
			...global,
			modelUnloadTimeout: legacyTimeout,
		},
	};
}

function partialDecodeBySections(payload: unknown): AppSettingsOutput {
	const defaults = appSettingsSchema.parse({});
	const payloadRecord = migrateLegacyGlobalSection(payload);
	const result: Record<string, unknown> = { ...defaults };
	for (const [key, sectionSchema] of Object.entries(
		appSettingsSectionSchemas,
	)) {
		const sectionParsed = (sectionSchema as z.ZodType).safeParse(
			payloadRecord[key],
		);
		if (sectionParsed.success) {
			result[key] = sectionParsed.data;
		}
	}
	return result as AppSettingsOutput;
}

export function decodeSettingsPayload(payload: unknown): AppSettingsOutput {
	const parsed = appSettingsSchema.safeParse(payload);
	if (parsed.success) {
		return normalizeHotkeys(parsed.data);
	}
	return normalizeHotkeys(partialDecodeBySections(payload));
}
