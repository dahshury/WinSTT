import { surfaceBg, useSurface } from "@/shared/lib/surface";

/**
 * Short leading/trailing code chip (e.g. "EN", "中", "PVP") shown before an
 * option label or at a group header's trailing edge. Surface-aware: it lifts
 * its fill one step above the surrounding surface so it reads as a raised pill
 * regardless of which elevation the picker sits on.
 *
 * Shared by every picker in this folder family so they read as one set.
 */
export function OptionBadge({ text }: { text: string }) {
	const level = Math.min(useSurface() + 1, 8);
	return (
		<span
			className={`pointer-events-none inline-flex h-4 min-w-[22px] shrink-0 items-center justify-center rounded-xs border border-border px-1 font-mono font-semibold text-[10px] text-foreground-secondary uppercase tracking-wider ${surfaceBg(level)}`}
		>
			{text}
		</span>
	);
}
