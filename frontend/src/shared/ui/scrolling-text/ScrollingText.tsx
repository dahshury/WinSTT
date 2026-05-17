"use client";

import { useEffect, useRef, useState } from "react";
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
	fadeColor = "rgba(8, 8, 12, 0.92)",
}: ScrollingTextProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const [isOverflowing, setIsOverflowing] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger for the re-measure + scroll; the body reads viewportRef instead of text directly.
	useEffect(() => {
		const el = viewportRef.current;
		if (!el) {
			return;
		}
		setIsOverflowing(el.scrollHeight > el.clientHeight + 1);
		el.scrollTop = el.scrollHeight;
	}, [text]);

	// Top fade obscures lines scrolling off the top — meant to overlap
	// outgoing text. Bottom fade sits in `paddingBottom` space *below* the
	// text so it never covers the last visible line. Resting box (no
	// overflow) is pixel-identical to the unstyled state.
	const topFade = `${lineHeight * 0.75}em`;
	const bottomFade = `${lineHeight * 0.6}em`;
	const baseHeight = `${maxLines * lineHeight}em`;
	const maxHeight = isOverflowing ? `calc(${baseHeight} + ${bottomFade})` : baseHeight;

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
				<p className="m-0 whitespace-pre-wrap break-words">{text}</p>
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
