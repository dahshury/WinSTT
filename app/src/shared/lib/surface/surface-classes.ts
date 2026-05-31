type Level = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

const SURFACE_BG: Record<Level, string> = {
	1: "bg-surface-1",
	2: "bg-surface-2",
	3: "bg-surface-3",
	4: "bg-surface-4",
	5: "bg-surface-5",
	6: "bg-surface-6",
	7: "bg-surface-7",
	8: "bg-surface-8",
};

const SURFACE_SHADOW: Record<Level, string> = {
	1: "shadow-surface-1",
	2: "shadow-surface-2",
	3: "shadow-surface-3",
	4: "shadow-surface-4",
	5: "shadow-surface-5",
	6: "shadow-surface-6",
	7: "shadow-surface-7",
	8: "shadow-surface-8",
};

const SURFACE_HOVER_BG: Record<Level, string> = {
	1: "hover:bg-surface-1",
	2: "hover:bg-surface-2",
	3: "hover:bg-surface-3",
	4: "hover:bg-surface-4",
	5: "hover:bg-surface-5",
	6: "hover:bg-surface-6",
	7: "hover:bg-surface-7",
	8: "hover:bg-surface-8",
};

const SURFACE_HIGHLIGHTED_BG: Record<Level, string> = {
	1: "data-[highlighted]:bg-surface-1",
	2: "data-[highlighted]:bg-surface-2",
	3: "data-[highlighted]:bg-surface-3",
	4: "data-[highlighted]:bg-surface-4",
	5: "data-[highlighted]:bg-surface-5",
	6: "data-[highlighted]:bg-surface-6",
	7: "data-[highlighted]:bg-surface-7",
	8: "data-[highlighted]:bg-surface-8",
};

const SURFACE_CHECKED_BG: Record<Level, string> = {
	1: "data-[checked]:bg-surface-1",
	2: "data-[checked]:bg-surface-2",
	3: "data-[checked]:bg-surface-3",
	4: "data-[checked]:bg-surface-4",
	5: "data-[checked]:bg-surface-5",
	6: "data-[checked]:bg-surface-6",
	7: "data-[checked]:bg-surface-7",
	8: "data-[checked]:bg-surface-8",
};

const SURFACE_SELECTED_BG: Record<Level, string> = {
	1: "data-[selected]:bg-surface-1",
	2: "data-[selected]:bg-surface-2",
	3: "data-[selected]:bg-surface-3",
	4: "data-[selected]:bg-surface-4",
	5: "data-[selected]:bg-surface-5",
	6: "data-[selected]:bg-surface-6",
	7: "data-[selected]:bg-surface-7",
	8: "data-[selected]:bg-surface-8",
};

const SURFACE_ACTIVE_PSEUDO_BG: Record<Level, string> = {
	1: "active:bg-surface-1",
	2: "active:bg-surface-2",
	3: "active:bg-surface-3",
	4: "active:bg-surface-4",
	5: "active:bg-surface-5",
	6: "active:bg-surface-6",
	7: "active:bg-surface-7",
	8: "active:bg-surface-8",
};

const SURFACE_BG_90: Record<Level, string> = {
	1: "bg-surface-1/90",
	2: "bg-surface-2/90",
	3: "bg-surface-3/90",
	4: "bg-surface-4/90",
	5: "bg-surface-5/90",
	6: "bg-surface-6/90",
	7: "bg-surface-7/90",
	8: "bg-surface-8/90",
};

const SURFACE_POPUP_OPEN_BG: Record<Level, string> = {
	1: "data-[popup-open]:bg-surface-1",
	2: "data-[popup-open]:bg-surface-2",
	3: "data-[popup-open]:bg-surface-3",
	4: "data-[popup-open]:bg-surface-4",
	5: "data-[popup-open]:bg-surface-5",
	6: "data-[popup-open]:bg-surface-6",
	7: "data-[popup-open]:bg-surface-7",
	8: "data-[popup-open]:bg-surface-8",
};

function clamp(level: number): Level {
	// Guard non-finite input: Math.round(NaN) is NaN and slips past min/max,
	// and the `as Level` cast launders it into a map miss → `bg-undefined`
	// (an unresolvable Tailwind class). A bad computed prop or
	// Number(<non-numeric setting>) degrades gracefully to the base surface
	// instead of emitting broken styling.
	if (!Number.isFinite(level)) {
		return 1;
	}
	return Math.max(1, Math.min(8, Math.round(level))) as Level;
}

export function surfaceClasses(bgLevel: number, shadowLevel: number = bgLevel): string {
	return `${SURFACE_BG[clamp(bgLevel)]} ${SURFACE_SHADOW[clamp(shadowLevel)]}`;
}

export function surfaceBg(level: number): string {
	return SURFACE_BG[clamp(level)];
}

export function surfaceShadow(level: number): string {
	return SURFACE_SHADOW[clamp(level)];
}

export function surfaceHoverBg(level: number): string {
	return SURFACE_HOVER_BG[clamp(level)];
}

export function surfaceHighlightedBg(level: number): string {
	return SURFACE_HIGHLIGHTED_BG[clamp(level)];
}

export function surfaceCheckedBg(level: number): string {
	return SURFACE_CHECKED_BG[clamp(level)];
}

export function surfaceSelectedBg(level: number): string {
	return SURFACE_SELECTED_BG[clamp(level)];
}

export function surfacePopupOpenBg(level: number): string {
	return SURFACE_POPUP_OPEN_BG[clamp(level)];
}

export function surfaceBg90(level: number): string {
	return SURFACE_BG_90[clamp(level)];
}

export function surfaceActivePseudoBg(level: number): string {
	return SURFACE_ACTIVE_PSEUDO_BG[clamp(level)];
}
