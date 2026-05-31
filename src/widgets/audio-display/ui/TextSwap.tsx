import { useEffect, useRef, useState } from "react";
import { cn } from "@/shared/lib/cn";

const SWAP_DUR_MS = 150;

/**
 * Transitions.dev three-phase text swap: the old text slides up + blurs + fades
 * out, the text is swapped, then the new text animates in from below. Drives the
 * `.t-text-swap` CSS (globals.css) via class toggles. Under reduced motion it
 * swaps instantly (no flicker).
 */
export function TextSwap({ text, className }: { text: string; className?: string }) {
	const [displayed, setDisplayed] = useState(text);
	const [phase, setPhase] = useState<"" | "exit" | "enter">("");
	const prev = useRef(text);
	const rafRef = useRef<number | null>(null);
	// Under reduced motion we render `text` directly (instant swap), so the
	// effect never has to mirror the prop into state synchronously.
	const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

	useEffect(() => {
		if (reduced || text === prev.current) {
			prev.current = text;
			return;
		}
		prev.current = text;
		// Phase 1: exit (slide up + blur + fade the old text).
		setPhase("exit");
		const exitTimer = setTimeout(() => {
			// Phase 2: swap the text + jump below with no transition.
			setDisplayed(text);
			setPhase("enter");
			// Phase 3: next frames, clear so it animates back to rest.
			rafRef.current = requestAnimationFrame(() => {
				rafRef.current = requestAnimationFrame(() => setPhase(""));
			});
		}, SWAP_DUR_MS);
		return () => {
			clearTimeout(exitTimer);
			if (rafRef.current !== null) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [text, reduced]);

	return (
		<span
			className={cn(
				"t-text-swap",
				phase === "exit" && "is-exit",
				phase === "enter" && "is-enter-start",
				className
			)}
		>
			{reduced ? text : displayed}
		</span>
	);
}
