import { useSurface } from "@/shared/lib/surface";

/** Clamp a surface level into the valid 1–8 range, raising by `by` steps. */
export function surfaceStep(level: number, by = 1): number {
	return Math.min(level + by, 8);
}

export interface PopupSurfaceLevels {
	/** Popup's two-step-above fill level. */
	popupLevel: number;
	/** Drop-shadow level for the popup (floored at 6 so it always casts). */
	popupShadow: number;
	/**
	 * The picker's own substrate level. For `selfElevate` callers this is
	 * `useSurface() + 1` (the value they re-provide via `SurfaceProvider` so
	 * option rows highlight against it); otherwise it equals the host surface.
	 */
	substrate: number;
	/** One-step-above fill level for the trigger/input box. */
	triggerLevel: number;
}

/**
 * Derives the `triggerLevel` / `popupLevel` / `popupShadow` triplet every
 * picker in this folder family computes the same way.
 *
 * `selfElevate` (default `true`) reproduces the `Select` / `SearchableSelect`
 * behaviour: they sit on a bare host panel with no wrapping `ElevatedSurface`,
 * so they self-elevate +1 to form their own substrate, then the trigger/input
 * lifts +1 above that and the popup +2. Pickers that already sit inside an
 * elevated context (`CreatableCombobox`, `EditableListCombobox`,
 * `LanguageMultiCombobox`) pass `selfElevate: false` so their trigger/input is
 * +1 and popup +2 above the *current* surface.
 *
 * The returned `triggerLevel` is what those latter callers historically named
 * `inputLevel`; it's the same value.
 */
export function usePopupSurfaceLevels({
	selfElevate = true,
}: { selfElevate?: boolean } = {}): PopupSurfaceLevels {
	const surface = useSurface();
	const substrate = selfElevate ? surfaceStep(surface) : surface;
	const triggerLevel = surfaceStep(substrate);
	const popupLevel = surfaceStep(substrate, 2);
	const popupShadow = Math.max(popupLevel, 6);
	return { substrate, triggerLevel, popupLevel, popupShadow };
}
