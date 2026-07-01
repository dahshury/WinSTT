import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";

/**
 * One datum chip on a card's recessed footer shelf: an icon (or brand logo) and
 * a value, with an optional hover title. `danger` strikes the value through and
 * tints it red for a failed datum; `truncate` clamps long values (ids) so the
 * strip stays one line.
 */
export interface EntryCardMetaPart {
	danger?: boolean;
	icon: IconSvgElement;
	key: string;
	logo?: string | null;
	title?: string;
	truncate?: boolean;
	value: string;
}

function EntryCardMetaShelf({
	cardLevel,
	parts,
}: {
	cardLevel: number;
	parts: EntryCardMetaPart[];
}) {
	return (
		// Recessed meta shelf: full-bleed to the card's bottom + side edges (negative
		// margins MUST match the card's px-3.5/py-3), split off by a hairline, and
		// stepped DOWN one surface so it reads as a ledge under the card body.
		<div
			className={cn(
				"-mx-3.5 -mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-divider border-t px-3.5 pt-2.5 pb-3 text-foreground-secondary text-xs-tight",
				surfaceBg(Math.max(cardLevel - 1, 1)),
			)}
		>
			{parts.map((part) => (
				<span
					className="inline-flex min-w-0 items-center gap-1 tabular-nums"
					key={part.key}
					title={part.title}
				>
					{part.logo ? (
						<img
							alt=""
							aria-hidden="true"
							className={cn(
								"size-3.5 shrink-0 rounded-[3px] object-contain",
								part.danger && "grayscale opacity-70",
							)}
							src={part.logo}
						/>
					) : (
						<HugeiconsIcon
							aria-hidden="true"
							className={cn(
								"size-3.5 shrink-0",
								part.danger ? "text-error" : "text-foreground-muted",
							)}
							icon={part.icon}
							strokeWidth={1.75}
						/>
					)}
					<span
						className={cn(
							part.truncate ? "max-w-[10rem] truncate" : "whitespace-nowrap",
							part.danger &&
								"text-error line-through decoration-2 decoration-error/80",
						)}
					>
						{part.value}
					</span>
				</span>
			))}
		</div>
	);
}

/**
 * A single elevated card inside an {@link EntryCardShell}: a free-form body
 * region above a recessed meta "shelf" stepped one surface below the card. The
 * card lifts +1 from its substrate and re-provides that level so body controls
 * elevate from here (FF surfaces — no flat tokens). Shared by the transcription
 * history table and the diagnostics issue list; only the body and footer data
 * differ between them.
 */
export function EntryCard({
	children,
	footer,
}: {
	children: ReactNode;
	footer: EntryCardMetaPart[];
}) {
	const cardLevel = Math.min(useSurface() + 1, 8);
	return (
		// Per-card padding wrapper: virtua measures the border-box (margins are NOT
		// counted), so the inter-card gap lives here as padding, never as a margin
		// on the card itself.
		<div className="py-1">
			<SurfaceProvider value={cardLevel}>
				<div
					className={cn(
						"flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border px-3.5 py-3",
						surfaceClasses(cardLevel, Math.max(cardLevel - 1, 1)),
						"transition-colors duration-150",
						surfaceHoverBg(Math.min(cardLevel + 1, 8)),
						"hover:border-border-hover",
					)}
				>
					{children}
					{footer.length > 0 ? (
						<EntryCardMetaShelf cardLevel={cardLevel} parts={footer} />
					) : null}
				</div>
			</SurfaceProvider>
		</div>
	);
}
