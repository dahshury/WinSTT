import type { ComponentPropsWithoutRef, Ref } from "react";
import { useLayoutEffect, useRef } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses, useSurface } from "@/shared/lib/surface";

/** The `text-[13px] leading-[1.5]` line box in pixels. Used only when the
 *  environment cannot report a computed line-height — happy-dom under
 *  `bun test`, or an element inside a `display:none` subtree — so the row math
 *  yields sane bounds instead of NaN. */
const FALLBACK_LINE_HEIGHT_PX = 19.5;

/** Deepest step the surface ramp defines. */
const MAX_SURFACE_LEVEL = 8;

const DEFAULT_MIN_ROWS = 3;
const DEFAULT_MAX_ROWS = 10;

function pxOrZero(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

interface BoxMetrics {
	/** Vertical padding + border. `height` covers it under border-box sizing but
	 *  `lineHeight * rows` does not, so the row bounds have to add it back or the
	 *  control caps roughly one row short of `maxRows`. */
	chrome: number;
	lineHeight: number;
}

function readBoxMetrics(el: HTMLTextAreaElement): BoxMetrics {
	const computed = getComputedStyle(el);
	// `line-height: normal` (and happy-dom's empty string) parse to NaN.
	const lineHeight = pxOrZero(computed.lineHeight);
	return {
		chrome:
			pxOrZero(computed.paddingTop) +
			pxOrZero(computed.paddingBottom) +
			pxOrZero(computed.borderTopWidth) +
			pxOrZero(computed.borderBottomWidth),
		lineHeight: lineHeight > 0 ? lineHeight : FALLBACK_LINE_HEIGHT_PX,
	};
}

/**
 * Size `el` to its content, floored at `minRows` and capped at `maxRows`.
 *
 * The height is written imperatively rather than held in state: it is a
 * measurement of the DOM, not a source of truth, and routing it through state
 * would re-render on every keystroke and open a measure → render → measure loop.
 */
function fitToContent(
	el: HTMLTextAreaElement,
	minRows: number,
	maxRows: number,
): void {
	// `scrollHeight` only reports the CONTENT height while the box is not already
	// stretched to the previous (taller) value, so release the height first.
	el.style.height = "auto";
	const contentHeight = el.scrollHeight;
	if (contentHeight <= 0) {
		// No layout to measure: happy-dom reports every box metric as 0, as does any
		// element in a `display:none` subtree. Pinning the height to 0 would collapse
		// the control into an invisible strip, so hand sizing back to the `rows`
		// attribute (which is `minRows`) until the element is actually laid out.
		el.style.height = "";
		el.style.overflowY = "";
		return;
	}
	const { chrome, lineHeight } = readBoxMetrics(el);
	const minHeight = lineHeight * minRows + chrome;
	const maxHeight = lineHeight * maxRows + chrome;
	const nextHeight = Math.min(Math.max(contentHeight, minHeight), maxHeight);
	el.style.height = `${nextHeight}px`;
	el.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}

export interface AutoTextareaProps
	extends Omit<ComponentPropsWithoutRef<"textarea">, "rows"> {
	/** Tallest the control grows before it scrolls internally. Default 10. */
	maxRows?: number;
	/** Shortest the control ever renders, and the `rows` attribute used before —
	 *  or instead of — a successful measurement. Default 3. */
	minRows?: number;
	ref?: Ref<HTMLTextAreaElement>;
	/** Surface step to paint on. Defaults to one above the substrate, the same
	 *  lift `TextField` applies. Pass it explicitly when the caller resolved the
	 *  level OUTSIDE the subtree this renders in — dialog bodies are assembled
	 *  before the popup's `SurfaceProvider` is in scope, so their inputs would
	 *  otherwise jump a step when the surface moves inside the component. */
	surfaceLevel?: number;
}

/**
 * A textarea that grows with its content instead of clipping it behind a native
 * resize grip. Height tracks the text from `minRows` up to `maxRows`, then the
 * control scrolls internally; `resize` is off entirely, so the OS-styled corner
 * grip — which honours no token in the design system — is gone.
 */
export function AutoTextarea({
	className,
	maxRows = DEFAULT_MAX_ROWS,
	minRows = DEFAULT_MIN_ROWS,
	onInput,
	ref,
	surfaceLevel,
	value,
	...props
}: AutoTextareaProps) {
	const substrate = useSurface();
	const level = surfaceLevel ?? Math.min(substrate + 1, MAX_SURFACE_LEVEL);
	const innerRef = useRef<HTMLTextAreaElement>(null);

	// Layout effect, not effect: the height is corrected before paint, so a long
	// seeded value never flashes at `minRows` first. Writing `style.height` sets
	// no state, so this cannot re-trigger itself.
	useLayoutEffect(() => {
		const el = innerRef.current;
		if (el) {
			fitToContent(el, minRows, maxRows);
		}
	}, [maxRows, minRows, value]);

	return (
		<textarea
			className={cn(
				// `text-[13px] leading-[1.5]` is the `text-body` token spelled with
				// arbitrary values deliberately: twMerge misreads NAMED font-size tokens
				// as text-COLOR and drops `text-body` against the `text-foreground` in
				// this same cn() call. Spelling the leading out also makes the row math
				// above deterministic rather than dependent on an inherited line-height.
				"w-full resize-none rounded-lg p-2.5 text-[13px] text-foreground leading-[1.5] caret-accent outline-none placeholder:text-foreground-muted focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1",
				surfaceClasses(level),
				className,
			)}
			// RTL is a first-class case here (Arabic prompts and transcripts), so
			// paragraph direction follows the content unless a caller overrides it.
			dir="auto"
			onInput={(event) => {
				// Covers the writes the value-keyed effect cannot see: uncontrolled use,
				// and IME composition where the committed text lands without a render.
				fitToContent(event.currentTarget, minRows, maxRows);
				onInput?.(event);
			}}
			ref={(node) => {
				innerRef.current = node;
				if (typeof ref === "function") {
					ref(node);
				} else if (ref) {
					ref.current = node;
				}
			}}
			// Pre-measurement height, and the graceful degrade when there is no layout
			// to measure — see the zero-height branch in `fitToContent`.
			rows={minRows}
			value={value}
			{...props}
		/>
	);
}
