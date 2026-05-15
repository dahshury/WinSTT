"use client";

import { AnimatePresence, domAnimation, LazyMotion, m } from "motion/react";
import { type ComponentPropsWithoutRef, useEffect, useState } from "react";
import { cn } from "@/shared/lib/cn";

const CIRCLE_A =
	"M 12 8 C 14.21 8 16 9.79 16 12 C 16 14.21 14.21 16 12 16 C 9.79 16 8 14.21 8 12 C 8 9.79 9.79 8 12 8 Z";
const INFINITY_PATH =
	"M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z";
const CIRCLE_B =
	"M 12 16 C 14.21 16 16 14.21 16 12 C 16 9.79 14.21 8 12 8 C 9.79 8 8 9.79 8 12 C 8 14.21 9.79 16 12 16 Z";

const DEFAULT_WORDS = ["Thinking", "Planning", "Refining", "Polishing"] as const;
const WORD_ROTATION_MS = 4000;

function longestWord(words: readonly string[]): string {
	return words.reduce((a, b) => (a.length >= b.length ? a : b));
}

export interface ThinkingIndicatorProps extends ComponentPropsWithoutRef<"div"> {
	/** Cycle of status words shown one at a time with a shimmer animation. */
	words?: readonly string[];
}

export function ThinkingIndicator({
	className,
	words = DEFAULT_WORDS,
	...rest
}: ThinkingIndicatorProps) {
	const [index, setIndex] = useState(0);

	useEffect(() => {
		const id = setInterval(() => {
			setIndex((i) => (i + 1) % words.length);
		}, WORD_ROTATION_MS);
		return () => clearInterval(id);
	}, [words.length]);

	const current = words[index] ?? "";
	const widestWord = longestWord(words);

	return (
		<LazyMotion features={domAnimation} strict>
			<div
				aria-live="polite"
				className={cn("inline-flex items-center gap-2 px-3 py-1.5", className)}
				role="status"
				{...rest}
			>
				<m.svg
					aria-hidden
					className="shrink-0 text-white/85"
					fill="none"
					height={18}
					stroke="currentColor"
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={1.5}
					viewBox="0 0 24 24"
					width={18}
				>
					<m.path
						animate={{ d: [CIRCLE_A, INFINITY_PATH, CIRCLE_B, INFINITY_PATH, CIRCLE_A] }}
						transition={{
							d: {
								duration: 6,
								ease: "easeInOut",
								repeat: Number.POSITIVE_INFINITY,
								times: [0, 0.25, 0.5, 0.75, 1],
							},
						}}
					/>
				</m.svg>
				<span className="inline-grid overflow-hidden font-medium text-[13px] leading-tight">
					<span aria-hidden="true" className="shimmer-text invisible col-start-1 row-start-1">
						{widestWord}
					</span>
					<AnimatePresence initial={false} mode="popLayout">
						<m.span
							animate={{
								y: 0,
								opacity: 1,
								transition: { duration: 0.24, ease: [0.4, 0, 0.2, 1] },
							}}
							className="shimmer-text col-start-1 row-start-1"
							exit={{
								y: "-80%",
								opacity: 0,
								transition: { duration: 0.16, ease: [0.4, 0, 0.2, 1] },
							}}
							initial={{ y: "80%", opacity: 0 }}
							key={current}
						>
							{current}
						</m.span>
					</AnimatePresence>
				</span>
			</div>
		</LazyMotion>
	);
}
