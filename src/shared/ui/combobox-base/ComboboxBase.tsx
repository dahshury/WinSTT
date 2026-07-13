import { Combobox } from "@base-ui/react/combobox";
import type { ReactNode } from "react";
import { SurfaceProvider } from "@/shared/lib/surface";

/**
 * Shared shell for the Base UI `Combobox`-wrapping pickers in this folder
 * family (`SearchableSelect`, `CreatableCombobox`, `EditableListCombobox`,
 * `LanguageMultiCombobox`). Each of those owns its own trigger + list body and
 * differentiating behaviour (single-search / creatable / editable-list /
 * multi-select), but they all mount the popup through the IDENTICAL
 * portal → surface-provider → positioner scaffolding and the same popup surface
 * classes. That common chrome lives here so it's one implementation. The
 * non-component helpers (`optionMatchesQuery`, `comboboxPopupClassName`,
 * `COMBOBOX_EMPTY_CLASS`) live in the sibling `ComboboxBase.helpers.ts`.
 */

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
