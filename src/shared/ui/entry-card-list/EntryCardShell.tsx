import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";

/**
 * The outer "bigger rectangle" that frames a list of {@link EntryCard}s: a
 * single bordered, rounded surface lifted +1 from its substrate, re-providing
 * that level so the cards inside elevate from here. The scrolling body (plain
 * or virtualized) is supplied as children, so callers keep control of paging
 * while sharing the frame. Shared by the transcription history table and the
 * diagnostics issue list.
 */
export function EntryCardShell({ children }: { children: ReactNode }) {
	const level = Math.min(useSurface() + 1, 8);
	return (
		<SurfaceProvider value={level}>
			<div
				className={cn(
					"overflow-hidden rounded-xl border border-border",
					surfaceBg(level),
				)}
			>
				{children}
			</div>
		</SurfaceProvider>
	);
}
