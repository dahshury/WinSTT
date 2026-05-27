import type { InputGroupTone } from "@/shared/ui/input-group";

export const FOOTER_TOOLTIP_DELAY = 1500;

export const TONE_TEXT: Record<InputGroupTone, string> = {
	default: "text-foreground",
	active: "text-foreground",
	danger: "text-error",
	muted: "text-foreground-dim opacity-70",
};

export function resolveTone(isConnected: boolean, isPressed: boolean): InputGroupTone {
	if (!isConnected) {
		return "muted";
	}
	if (isPressed) {
		return "active";
	}
	return "default";
}
