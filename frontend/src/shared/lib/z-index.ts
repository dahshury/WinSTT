/**
 * Centralized z-index scale for portaled overlays.
 *
 * Portals escape the parent stacking context, so these compete only with each
 * other — kept as a small ordered scale: dropdowns < submenus < tooltips.
 */
export const Z_INDEX = {
	dropdown: 40,
	dropdownSubmenu: 41,
	tooltip: 50,
} as const;
