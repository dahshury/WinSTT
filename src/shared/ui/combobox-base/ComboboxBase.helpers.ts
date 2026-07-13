import { matchesFuzzySearch } from "@/shared/lib/fuzzy-search";
import { surfaceClasses } from "@/shared/lib/surface";
import type { SelectOption } from "@/shared/ui/select";

/**
 * Non-component helpers shared by the Base UI `Combobox`-wrapping pickers
 * (`SearchableSelect`, `CreatableCombobox`, `EditableListCombobox`,
 * `LanguageMultiCombobox`) and the `ComboboxPopupShell` component. Kept in a
 * plain `.ts` sibling so the `.tsx` module exports only its component.
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
