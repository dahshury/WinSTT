import { PulseDot } from "@/shared/ui/pulse-dot";

/** Compact uppercase pill (accent-glow background, pulse dot, mono caps)
 *  intended to replace the trigger's chevron on the right edge while a swap
 *  is in flight. Single, calm state indicator — the bottom sweep carries the
 *  motion. */
export function SwitchingPill({
	label = "Switching",
	showDot = true,
}: {
	label?: string;
	showDot?: boolean;
}) {
	return (
		<span className="ms-2 inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-glow px-2 py-0.5 font-mono font-semibold text-[10px] text-accent uppercase tracking-[0.12em]">
			{showDot ? <PulseDot className="size-1.5" /> : null}
			{label}
		</span>
	);
}
