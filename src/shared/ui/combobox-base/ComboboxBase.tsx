import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { SurfaceProvider, surfaceClasses } from "@/shared/lib/surface";
import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import type { SelectOption } from "@/shared/ui/select";

/**
 * Shared shell for the Base UI `Combobox`-wrapping pickers in this folder
 * family (`SearchableSelect`, `CreatableCombobox`, `EditableListCombobox`,
 * `LanguageMultiCombobox`). Each of those owns its own trigger + list body and
 * differentiating behaviour (single-search / creatable / editable-list /
 * multi-select), but they all mount the popup through the IDENTICAL
 * portal → surface-provider → positioner scaffolding and the same popup surface
 * classes. That common chrome lives here so it's one implementation.
 */

/** Empty-state row classes shared by the pickers that render a plain empty
 *  message (Creatable / EditableList / LanguageMulti). SearchableSelect keeps
 *  its own `searchable-select-empty` CSS-animated variant. */
export const COMBOBOX_EMPTY_CLASS =
	"px-2.5 py-2 text-body-sm text-foreground-muted";

/**
 * The fuzzy filter every OPTION-based combobox uses: match the typed query
 * against a row's label, id, and optional badge. Shared by `SearchableSelect`
 * (Base UI's internal `filter`) and `LanguageMultiCombobox` (manual filtering).
 */
export function optionMatchesQuery(
	option: SelectOption,
	query: string,
): boolean {
	return matchesFuzzySearch(
		[option.label, option.id, option.badge ?? ""],
		query,
	);
}

/**
 * Build the popup's surface className. The invariant scaffolding (anchor width,
 * available-width cap, transform origin, rounding, and the surface fill/shadow)
 * is appended to the caller's `extra` classes — which carry the per-variant
 * animation class (`searchable-select-popup` / `editable-list-combobox-popup`),
 * overflow, padding, and max-height.
 *
 * Built by string concatenation, NOT `cn`/twMerge: `surfaceClasses` emits custom
 * shadow-surface tokens that twMerge silently drops.
 */
export function comboboxPopupClassName(
	popupLevel: number,
	popupShadow: number,
	extra: string,
): string {
	return `${extra} w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] rounded-lg ${surfaceClasses(popupLevel, popupShadow)}`;
}

/**
 * The `Combobox.Portal` → `SurfaceProvider` → `Combobox.Positioner` wrapper that
 * every picker here mounts its popup inside. `children` is the positioner body
 * (typically a `Combobox.Popup`, optionally wrapped for a scrollbar mask), so the
 * shell stays agnostic to each picker's list rendering.
 */
export function ComboboxPopupShell({
	children,
	popupLevel,
}: {
	children: ReactNode;
	popupLevel: number;
}) {
	return (
		<Combobox.Portal>
			<SurfaceProvider value={popupLevel}>
				<Combobox.Positioner
					className="z-popover outline-none"
					collisionPadding={8}
					sideOffset={4}
				>
					{children}
				</Combobox.Positioner>
			</SurfaceProvider>
		</Combobox.Portal>
	);
}
