import { formatKeyName } from "@/shared/lib/format-key-name";
import { compareHotkeys, isHotkeyConflict } from "@/shared/lib/hotkey-conflict";

/**
 * One row in the `forbiddenCombos` prop. `combo` is the uiohook accelerator
 * string the other hotkey is currently bound to; `label` is the human-readable
 * name of that other hotkey (already i18n-resolved by the caller) used in the
 * inline error so the user sees WHICH binding is colliding, not just THAT one is.
 */
export interface ForbiddenCombo {
	combo: string;
	label: string;
}

export function formatCombo(combo: string): string {
	// Drop empty/whitespace-only segments so a partial or malformed accelerator
	// ("", "Ctrl+", "Ctrl+ ") renders cleanly ("", "Ctrl") instead of leaking a
	// dangling " + " or formatting an empty token. ("+" is the delimiter, so it
	// is never itself a key segment in this scheme.)
	return combo
		.split("+")
		.filter((token) => token.trim().length > 0)
		.map(formatKeyName)
		.join(" + ");
}

/**
 * Resolves the text shown in the hotkey display box.
 * Extracted as a pure function for testability.
 */
export function resolveDisplayText(
	recording: boolean,
	liveKeys: string[],
	currentKey: string,
	pressKeysLabel: string,
): string {
	if (!recording) {
		return formatCombo(currentKey);
	}
	if (liveKeys.length > 0) {
		return liveKeys.map(formatKeyName).join(" + ");
	}
	return pressKeysLabel;
}

/**
 * Scan `forbiddenCombos` for the first conflict against `candidate`. Pure so
 * the wiring stays test-friendly and the component body stays small.
 */
export function findConflict(
	candidate: string,
	forbiddenCombos: readonly ForbiddenCombo[] | undefined,
): ForbiddenCombo | null {
	if (!forbiddenCombos) {
		return null;
	}
	for (const entry of forbiddenCombos) {
		if (isHotkeyConflict(compareHotkeys(candidate, entry.combo))) {
			return entry;
		}
	}
	return null;
}
