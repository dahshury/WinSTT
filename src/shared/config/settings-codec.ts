import type { z } from "zod";
import { resolveHotkeySet } from "@/shared/lib/hotkey-conflict";
import { isPlainRecord } from "@/shared/lib/is-record";
import {
	type AppSettingsOutput,
	appSettingsSchema,
	appSettingsSectionSchemas,
} from "./settings-schema";

/**
 * Diagnostics describing what recovery the decoder had to perform on a payload.
 *
 * - `defaultedSections`: top-level sections whose `safeParse` failed and were
 *   substituted with schema defaults. Surfaced so the app can WARN the user
 *   (their persisted data for that section couldn't be read) instead of
 *   silently healing corruption into permanent loss on the next save.
 * - `hotkeyRewrites`: hotkeys the conflict resolver had to reset to defaults
 *   because they collided. Previously computed then discarded, so colliding
 *   hotkeys silently reverted on load with no user-visible notice.
 */
export interface SettingsDecodeDiagnostics {
	defaultedSections: string[];
	hotkeyRewrites: string[];
}

export interface DecodedSettings {
	diagnostics: SettingsDecodeDiagnostics;
	settings: AppSettingsOutput;
}

/**
 * Normalize the five globally-registered hotkeys so no pair is in a
 * subset / superset / equal relationship. Defense in depth: the recorder UI
 * already blocks conflicts at capture time, but settings.json can be edited
 * out-of-band (manual edit, sync conflict, older app version), and the
 * runtime registrars would silently double-fire on the colliding combos.
 *
 * Policy is defined by `resolveHotkeySet`: PTT wins; the other four reset
 * to their schema defaults when they collide. The defaults themselves are
 * pulled from a fresh `appSettingsSchema.parse({})` so this stays a single
 * source of truth — no duplicated literal strings to drift.
 *
 * Returns the settled value plus the list of hotkeys the resolver rewrote, so
 * the caller can surface a notice (audit #26 — rewrites were being discarded).
 */
function hotkeySetUnchanged(
	values: {
		profileSwapHotkey: string;
		pushToTalkKey: string;
		repasteHotkey: string;
		transformHotkey: string;
		ttsHotkey: string;
	},
	parsed: AppSettingsOutput,
): boolean {
	return (
		values.pushToTalkKey === parsed.hotkey.pushToTalkKey &&
		values.repasteHotkey === parsed.general.repasteHotkey &&
		values.ttsHotkey === parsed.tts.hotkey &&
		values.transformHotkey === parsed.llm.transforms.hotkey &&
		values.profileSwapHotkey === parsed.llm.profileSwapHotkey
	);
}

function normalizeHotkeys(parsed: AppSettingsOutput): {
	rewrites: string[];
	settings: AppSettingsOutput;
} {
	const defaults = appSettingsSchema.parse({});
	const { values, rewrites } = resolveHotkeySet(
		{
			pushToTalkKey: parsed.hotkey.pushToTalkKey,
			repasteHotkey: parsed.general.repasteHotkey,
			ttsHotkey: parsed.tts.hotkey,
			transformHotkey: parsed.llm.transforms.hotkey,
			profileSwapHotkey: parsed.llm.profileSwapHotkey,
		},
		{
			pushToTalkKey: defaults.hotkey.pushToTalkKey,
			repasteHotkey: defaults.general.repasteHotkey,
			ttsHotkey: defaults.tts.hotkey,
			transformHotkey: defaults.llm.transforms.hotkey,
			profileSwapHotkey: defaults.llm.profileSwapHotkey,
		},
	);
	// Preserve referential equality downstream (Zustand selector memoization,
	// React Compiler) when nothing actually changed.
	if (hotkeySetUnchanged(values, parsed)) {
		return { settings: parsed, rewrites };
	}
	return {
		settings: {
			...parsed,
			hotkey: { ...parsed.hotkey, pushToTalkKey: values.pushToTalkKey },
			general: { ...parsed.general, repasteHotkey: values.repasteHotkey },
			tts: { ...parsed.tts, hotkey: values.ttsHotkey },
			llm: {
				...parsed.llm,
				profileSwapHotkey: values.profileSwapHotkey,
				transforms: {
					...parsed.llm.transforms,
					hotkey: values.transformHotkey,
				},
			},
		},
		rewrites,
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
 *
 * Returns the recovered settings plus the list of sections that had to fall
 * back to defaults (audit #45 — this was silent, and the next save then
 * persisted the defaulted section over the still-readable disk value).
 */
function payloadAsRecord(payload: unknown): Record<string, unknown> {
	return isPlainRecord(payload) ? payload : {};
}

function partialDecodeBySections(payload: unknown): {
	defaultedSections: string[];
	settings: AppSettingsOutput;
} {
	const defaults = appSettingsSchema.parse({});
	const payloadRecord = payloadAsRecord(payload);
	const result: Record<string, unknown> = { ...defaults };
	const defaultedSections: string[] = [];
	for (const [key, sectionSchema] of Object.entries(
		appSettingsSectionSchemas,
	)) {
		const sectionParsed = (sectionSchema as z.ZodType).safeParse(
			payloadRecord[key],
		);
		if (sectionParsed.success) {
			result[key] = sectionParsed.data;
		} else if (payloadRecord[key] !== undefined) {
			// Only report a section as "defaulted due to corruption" when the
			// payload actually carried a value for it — an absent key legitimately
			// resolves to its default and is not data loss.
			defaultedSections.push(key);
		}
	}
	return { settings: result as AppSettingsOutput, defaultedSections };
}

/**
 * Decode a raw settings payload AND report what recovery was needed. Callers
 * that persist the result use the diagnostics to (a) warn the user and (b)
 * avoid overwriting disk with a section that only defaulted because it failed
 * to parse (which would turn a recoverable corruption into permanent loss).
 */
export function decodeSettingsWithDiagnostics(
	payload: unknown,
): DecodedSettings {
	const parsed = appSettingsSchema.safeParse(payload);
	if (parsed.success) {
		const { settings, rewrites } = normalizeHotkeys(parsed.data);
		return {
			settings,
			diagnostics: { defaultedSections: [], hotkeyRewrites: rewrites },
		};
	}
	const { settings: recovered, defaultedSections } =
		partialDecodeBySections(payload);
	const { settings, rewrites } = normalizeHotkeys(recovered);
	return {
		settings,
		diagnostics: { defaultedSections, hotkeyRewrites: rewrites },
	};
}

export function decodeSettingsPayload(payload: unknown): AppSettingsOutput {
	return decodeSettingsWithDiagnostics(payload).settings;
}
