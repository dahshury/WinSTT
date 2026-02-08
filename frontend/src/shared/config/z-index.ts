/**
 * Global z-index scale. Every z-index in the app must reference this file.
 *
 * Layers (lowest → highest):
 *   SIDEBAR_INDICATOR  –  active-item bar inside the settings sidebar
 *   MODAL              –  modal backdrop + dialog
 *   POPOVER            –  dropdowns, selects, tooltips (must sit above modals)
 *   CONFIRM_DIALOG     –  destructive-action confirmation (must sit above everything interactive)
 *   NOISE_OVERLAY      –  cosmetic full-screen noise texture (pointer-events: none)
 */
export const Z_INDEX = {
	SIDEBAR_INDICATOR: 10,
	MODAL: 100,
	POPOVER: 200,
	CONFIRM_DIALOG: 300,
	NOISE_OVERLAY: 9999,
} as const;
