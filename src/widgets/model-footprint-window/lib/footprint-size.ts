export interface FootprintSizeInput {
	boxHeight: number;
	scrollHeight: number;
}

/** Transparent native-window breathing room for the rounded edge + shadow. */
const FOOTPRINT_WINDOW_GUTTER_PX = 6;
const FOOTPRINT_CONTENT_WIDTH_PX = 280;

/** Resolve the native popup size from both its current viewport-capped box and
 * its intrinsic scroll extent. The latter prevents `max-h-screen` from making
 * a cropped native window report that its already-cropped height is complete. */
export function resolveFootprintContentSize({
	boxHeight,
	scrollHeight,
}: FootprintSizeInput): { height: number; width: number } {
	return {
		height:
			Math.ceil(Math.max(boxHeight, scrollHeight)) +
			FOOTPRINT_WINDOW_GUTTER_PX * 2,
		// Width is deliberately independent of the current native viewport.
		// Feeding viewport width back into native sizing compounds DPI rounding
		// and makes this right-anchored popup grow left on every observer tick.
		width: FOOTPRINT_CONTENT_WIDTH_PX + FOOTPRINT_WINDOW_GUTTER_PX * 2,
	};
}
