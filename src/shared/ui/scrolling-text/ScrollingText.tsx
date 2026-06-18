import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

export interface ScrollingTextProps {
	className?: string;
	/** Color of the fade gradient — should match the container background so
	 *  the text appears to dissolve into the container's interior. Defaults to
	 *  a dark glass tint that works on most surfaces. */
	fadeColor?: string;
	lineHeight?: number;
	maxLines: number;
	text: string;
}

export function ScrollingText({
	text,
	maxLines,
	lineHeight = 1.5,
	className,
	fadeColor = "var(--color-overlay-fade)",
}: ScrollingTextProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	// Overflow is purely a function of the viewport's DOM measurements — it
	// can't be derived during render (no DOM access), so a ResizeObserver
	// fires `setIsOverflowing` whenever the viewport (or its children) reflow.
	// Triggering on observed resize instead of on the `text` prop avoids the
	// "adjust state on prop change" anti-pattern: the effect listens to the
	// real signal (layout) rather than guessing from a stand-in prop.
	const [isOverflowing, setIsOverflowing] = useState(false);

	useLayoutEffect(() => {
		const el = viewportRef.current;
		if (el === null) {
			return;
		}
		const measure = () => {
			setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
			el.scrollTop = el.scrollHeight;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		// Also watch the inner paragraph — `<p>` height grows with text
		// content, and ResizeObserver fires only for the boxes it observes.
		const child = el.firstElementChild;
		if (child) {
			observer.observe(child);
		}
		return () => observer.disconnect();
	}, []);

	// Top fade obscures lines scrolling off the top — meant to overlap
	// outgoing text. Bottom fade sits in `paddingBottom` space *below* the
	// text so it never covers the last visible line. Resting box (no
	// overflow) is pixel-identical to the unstyled state.
	const topFade = `${lineHeight * 0.75}em`;
	const bottomFade = `${lineHeight * 0.6}em`;
	const baseHeight = `${maxLines * lineHeight}em`;
	const maxHeight = isOverflowing
		? `calc(${baseHeight} + ${bottomFade})`
		: baseHeight;

	return (
		<div className={cn("relative", className)}>
			<div
				className="overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				ref={viewportRef}
				style={{
					lineHeight,
					maxHeight,
					paddingBottom: isOverflowing ? bottomFade : undefined,
				}}
			>
				{/* `dir="auto"` lets the bidi algorithm pick base direction from
				    the transcription content itself — RTL speech (Arabic/Hebrew)
				    reads right-to-left even though the UI stays LTR. */}
				<p className="m-0 whitespace-pre-wrap break-words" dir="auto">
					{text}
				</p>
			</div>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 top-0 z-raised transition-opacity duration-200"
				style={{
					background: `linear-gradient(to bottom, ${fadeColor} 0%, transparent 100%)`,
					height: topFade,
					opacity: isOverflowing ? 1 : 0,
				}}
			/>
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 bottom-0 z-raised transition-opacity duration-200"
				style={{
					background: `linear-gradient(to top, ${fadeColor} 0%, transparent 100%)`,
					height: bottomFade,
					opacity: isOverflowing ? 1 : 0,
				}}
			/>
		</div>
	);
}
