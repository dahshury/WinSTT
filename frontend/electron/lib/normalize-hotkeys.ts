import { resolveHotkeyTriple } from "../../src/shared/lib/hotkey-conflict";

/**
 * Boot-time hotkey normalizer for the main-process settings store.
 *
 * Defense in depth against settings.json on disk holding overlapping combos
 * for the three globally-registered hotkeys (PTT, repaste, TTS). The recorder
 * UI blocks conflicts at capture time, but persisted state can arrive from
 * other sources (manual edit, sync conflict, older app version). The runtime
 * registrars would silently double-fire on the colliding combos.
 *
 * Kept dependency-free (no electron imports) so the test mock harness can
 * exercise it directly — see `normalize-hotkeys.test.ts`. The integration
 * with `store.ts` is a single call at module load.
 *
 * Policy:
 *   - PTT is the anchor — never rewritten.
 *   - Repaste / TTS are reset to their schema defaults when they collide.
 *   - Defaults are inlined here (not imported from settings-schema) to keep
 *     this module's dependency surface trivial; the values are duplicated in
 *     exactly two places (here + the schema), and `normalize-hotkeys.test.ts`
 *     pins both to the same constants so drift would surface as a test break.
 */
const DEFAULTS = {
	pushToTalkKey: "LCtrl+LMeta",
	repasteHotkey: "LCtrl+LShift+V",
	ttsHotkey: "LMeta+LShift+E",
} as const;

export type HotkeyKey = "pushToTalkKey" | "repasteHotkey" | "ttsHotkey";

export function normalizePersistedHotkeys(
	read: (key: string) => unknown,
	write: (key: string, value: unknown) => void
): HotkeyKey[] {
	const readStr = (key: string, fallback: string): string => {
		const raw = read(key);
		return typeof raw === "string" && raw !== "" ? raw : fallback;
	};
	const candidate = {
		pushToTalkKey: readStr("hotkey.pushToTalkKey", DEFAULTS.pushToTalkKey),
		repasteHotkey: readStr("general.repasteHotkey", DEFAULTS.repasteHotkey),
		ttsHotkey: readStr("tts.hotkey", DEFAULTS.ttsHotkey),
	};
	const { values, rewrites } = resolveHotkeyTriple(candidate, DEFAULTS);
	if (rewrites.includes("repasteHotkey")) {
		write("general.repasteHotkey", values.repasteHotkey);
	}
	if (rewrites.includes("ttsHotkey")) {
		write("tts.hotkey", values.ttsHotkey);
	}
	return rewrites;
}
