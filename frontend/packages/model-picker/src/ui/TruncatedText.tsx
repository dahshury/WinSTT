"use client";

import type { Ref } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./Tooltip";

export interface TruncatedTextProps {
	className?: string;
	text: string;
	/** Hover delay before the tooltip opens, in ms. */
	tooltipDelay?: number;
}

function mergeRefs<T>(
	triggerRef: Ref<T> | undefined,
	external: React.RefObject<T | null>
): React.RefCallback<T> {
	return (el) => {
		if (typeof triggerRef === "function") {
			triggerRef(el);
		} else if (triggerRef && "current" in triggerRef) {
			(triggerRef as React.MutableRefObject<T | null>).current = el;
		}
		external.current = el;
	};
}

/**
 * Renders `text` inside a `truncate` span and pops a tooltip with the full
 * value when the rendered width is clipped. The tooltip is gated by a
 * ResizeObserver measurement of `scrollWidth > clientWidth`, so the popup
 * stays out of the way when nothing is hidden.
 */
export function TruncatedText({ className, text, tooltipDelay = 1500 }: TruncatedTextProps) {
	const ref = useRef<HTMLSpanElement | null>(null);
	const [truncated, setTruncated] = useState(false);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}
		const measure = () => {
			setTruncated(el.scrollWidth > el.clientWidth + 1);
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	return (
		<Tooltip delay={tooltipDelay} disabled={!truncated}>
			<TooltipTrigger
				render={(props) => {
					const { ref: triggerRef, ...rest } = props as typeof props & {
						ref?: Ref<HTMLSpanElement>;
					};
					return (
						<span
							{...rest}
							className={cn("min-w-0 truncate", className)}
							ref={mergeRefs(triggerRef, ref)}
						>
							{text}
						</span>
					);
				}}
			/>
			<TooltipContent>{text}</TooltipContent>
		</Tooltip>
	);
}
