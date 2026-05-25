/**
 * Global z-index scale. Single source of truth for stacking across the app.
 *
 * Two tiers:
 *   - In-flow local stacking (small values) — for siblings inside the same
 *     parent stacking context. Values <100 so they can never collide with
 *     portaled layers, even if an unintended stacking context promotes them.
 *   - Portaled overlays (≥1000) — rendered into document.body via Base UI's
 *     Portal. Spaced by 100 so new layers can be inserted without renumbering.
 *
 * Tailwind v4: mirrored in `app/styles/globals.css` as `--z-index-*` theme
 * tokens so `className="z-popover"` and `style={{ zIndex: Z_INDEX.popover }}`
 * produce the same value. Prefer the Tailwind utility in JSX; reach for the
 * constant only when a Base UI prop requires a number (e.g. Positioner style).
 *
 * Hierarchy (lowest → highest):
 *   raised             – sticky list headers, badges, fade masks, table rows
 *   overlay            – selection indicators above sibling pills
 *   titlebar           – frameless-window drag region
 *   titlebarFloat      – interactive item on top of the titlebar
 *   modalBackdrop      – modal scrim
 *   modal              – modal popup
 *   popover            – dropdowns, selects, comboboxes, menus
 *                        (above modals so a modal can host a popover)
 *   popoverSubmenu     – nested menus inside a popover
 *   tooltip            – above every interactive popover
 *   confirmBackdrop    – destructive-action confirm scrim
 *   confirm            – destructive-action confirm popup
 *   toast              – top-most interactive notification
 *   noiseOverlay       – cosmetic full-screen noise (pointer-events: none)
 */
export const Z_INDEX = {
	raised: 10,
	overlay: 20,
	titlebar: 30,
	titlebarFloat: 40,
	modalBackdrop: 1000,
	modal: 1001,
	popover: 1100,
	popoverSubmenu: 1101,
	tooltip: 1200,
	confirmBackdrop: 1300,
	confirm: 1301,
	toast: 1400,
	noiseOverlay: 9999,
} as const;
