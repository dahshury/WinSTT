const ACTIVE_ATTR = "data-scrollbar-visible";
// How long the bar stays painted after the last scroll tick before fading back
// out. Long enough that a brief pause mid-flick doesn't blink it away, short
// enough that it's gone shortly after you stop.
const IDLE_MS = 700;

let installed = false;

/**
 * App-wide auto-hiding native scrollbars, matching the settings `ScrollArea`.
 *
 * The native thumb is transparent at rest (see `globals.css`) and is only
 * painted while its element is actively being scrolled (mouse wheel, trackpad,
 * keyboard, or dragging the thumb — all of which fire `scroll`). This installs
 * a single capturing listener on the document that stamps
 * `data-scrollbar-visible` on whichever element just scrolled and clears it
 * after a short idle, so the bar fades in while scrolling and disappears once
 * you stop — everywhere (divs, `<textarea>`, `<pre>`, dropdown popups), not
 * just the Base UI ScrollArea regions.
 *
 * Idempotent and self-installing per window: every window entry renders
 * `HtmlLang`, which calls this at module load, so the seam exists in all 9
 * webviews. Base UI's own ScrollArea hides its native bar entirely
 * (`scrollbar-width: none`), so it's unaffected by the global styling.
 */
export function installScrollbarAutoHide(): void {
	if (installed || typeof document === "undefined") {
		return;
	}
	installed = true;

	const timers = new WeakMap<Element, number>();

	const onScroll = (event: Event) => {
		const node = event.target;
		// `scroll` on the page itself targets `document` (not an Element); route
		// that to the scrolling element so the page bar reveals too.
		const el =
			node instanceof Element
				? node
				: (document.scrollingElement ?? document.documentElement);
		if (!el) {
			return;
		}
		el.setAttribute(ACTIVE_ATTR, "");
		const prev = timers.get(el);
		if (prev !== undefined) {
			window.clearTimeout(prev);
		}
		timers.set(
			el,
			window.setTimeout(() => {
				el.removeAttribute(ACTIVE_ATTR);
				timers.delete(el);
			}, IDLE_MS),
		);
	};

	// Capture phase: `scroll` doesn't bubble, but a capturing listener on the
	// document still receives scroll events from every nested scroller.
	document.addEventListener("scroll", onScroll, {
		capture: true,
		passive: true,
	});
}
