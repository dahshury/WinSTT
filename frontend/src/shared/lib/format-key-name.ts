/** Map internal key names (from uiohook) to human-readable display labels. */
const DISPLAY_LABELS: Record<string, string> = {
	LCtrl: "L Ctrl",
	RCtrl: "R Ctrl",
	LAlt: "L Alt",
	RAlt: "R Alt",
	LShift: "L Shift",
	RShift: "R Shift",
	LMeta: "L Win",
	RMeta: "R Win",
};

export function formatKeyName(key: string): string {
	return DISPLAY_LABELS[key] ?? key;
}
