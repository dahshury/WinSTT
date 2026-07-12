import { metaKeyLabel } from "./host-platform";

/** Map internal key names (from uiohook) to human-readable display labels. */
const DISPLAY_LABELS: Record<string, string> = {
	LCtrl: "L Ctrl",
	RCtrl: "R Ctrl",
	LAlt: "L Alt",
	RAlt: "R Alt",
	LShift: "L Shift",
	RShift: "R Shift",
};

/** Meta keys are labelled per-OS: ⌘ (Cmd) on macOS, Super on Linux, Win on
 *  Windows — resolved at call time from the host-OS signal rather than
 *  hardcoded to "Win". */
const META_SIDE_BY_KEY: Record<string, "L" | "R"> = {
	LMeta: "L",
	RMeta: "R",
};

export function formatKeyName(key: string): string {
	const metaSide = META_SIDE_BY_KEY[key];
	if (metaSide) {
		return `${metaSide} ${metaKeyLabel()}`;
	}
	return DISPLAY_LABELS[key] ?? key;
}
