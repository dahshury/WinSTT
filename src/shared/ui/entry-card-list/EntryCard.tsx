import { AiCloud01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import {
	SurfaceProvider,
	surfaceBg,
	surfaceClasses,
	surfaceHoverBg,
	useSurface,
} from "@/shared/lib/surface";
import { Tooltip } from "@/shared/ui/tooltip";

/**
 * One datum chip on a card's recessed footer shelf: an icon (or brand logo) and
 * a value, with an optional hover title or rich tooltip. `danger` strikes the
 * value through and tints it red for a failed datum; `truncate` clamps long
 * values (ids) so the strip stays one line.
 */
export interface EntryCardMetaPart {
	/** Flags the datum as running on a cloud provider — appends a small cloud
	 *  sign after the value (`cloudLabel` becomes its accessible name). Mirrors
	 *  the main window's cloud cue so local/cloud models read apart at a glance. */
	cloud?: boolean;
	cloudLabel?: string;
	danger?: boolean;
	icon: IconSvgElement;
	key: string;
	logo?: string | null;
	/** Render the brand `logo` uncolored — alpha-masked to the chip's own muted
	 *  text color instead of a full-color `<img>` — so it sits in the footer's
	 *  monochrome shelf the way the main-window model chip does. */
	monoLogo?: boolean;
	/** Tint class for the icon + value (kind-colored chips); `danger` wins. */
	tint?: string;
	title?: string;
	truncate?: boolean;
	tooltip?: ReactNode;
	value: string;
}

/** The brand logo for a meta chip. `monoLogo` renders it alpha-masked to the
 *  chip's current text color (matching the main-window footer glyph); otherwise
 *  it's a full-color image. `danger` desaturates a failed datum's mark. */
function MetaLogo({ part }: { part: EntryCardMetaPart }): ReactNode {
	if (!part.logo) {
		return null;
	}
	if (part.monoLogo) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"size-3.5 shrink-0 bg-current [mask-image:var(--meta-logo)] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain] [-webkit-mask-image:var(--meta-logo)] [-webkit-mask-position:center] [-webkit-mask-repeat:no-repeat] [-webkit-mask-size:contain]",
					part.danger ? "text-error" : (part.tint ?? "text-foreground-muted"),
				)}
				style={{ "--meta-logo": `url("${part.logo}")` } as CSSProperties}
			/>
		);
	}
	return (
		<img
			alt=""
			aria-hidden="true"
			className={cn(
				"size-3.5 shrink-0 rounded-[3px] object-contain",
				part.danger && "grayscale opacity-70",
			)}
			src={part.logo}
		/>
	);
}

/** The chip's leading mark: its brand logo (or icon fallback), badged with a
 *  small cloud sign notched into the bottom-right corner when the datum ran on
 *  a cloud provider. The badge is punched out with the shelf's own surface color
 *  so the cloud reads cleanly over the logo — a compact, wordless cloud/local
 *  cue that mirrors the main-window model chip. */
function MetaGlyph({ part }: { part: EntryCardMetaPart }): ReactNode {
	// The shelf steps one surface below the card; match that so the badge's
	// punch-out disc blends into the strip rather than the card body.
	const shelfLevel = Math.max(useSurface() - 1, 1);
	const inner = part.logo ? (
		<MetaLogo part={part} />
	) : (
		<HugeiconsIcon
			aria-hidden="true"
			className={cn(
				"size-3.5 shrink-0",
				part.danger ? "text-error" : (part.tint ?? "text-foreground-muted"),
			)}
			icon={part.icon}
			strokeWidth={1.75}
		/>
	);
	if (!part.cloud) {
		return inner;
	}
	return (
		<span
			aria-label={part.cloudLabel}
			className="relative inline-flex shrink-0"
			role={part.cloudLabel ? "img" : undefined}
		>
			{inner}
			<span
				aria-hidden="true"
				className={cn(
					"-right-1 -bottom-1 absolute inline-flex items-center justify-center rounded-full text-foreground-muted",
					surfaceBg(shelfLevel),
				)}
			>
				<HugeiconsIcon icon={AiCloud01Icon} size={9} />
			</span>
		</span>
	);
}

function EntryCardMetaItem({ part }: { part: EntryCardMetaPart }) {
	// Every hover hint renders through the shared Tooltip — a plain `title`
	// string becomes its content when no rich tooltip is given. Native `title`
	// attributes are banned here: mixing OS tooltips with styled ones on the
	// same shelf reads as a bug.
	const hint = part.tooltip ?? part.title;
	const chip = (
		<span
			aria-label={hint ? part.title : undefined}
			className={cn(
				"inline-flex min-w-0 items-center gap-1 tabular-nums",
				hint &&
					"cursor-help rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
			)}
			tabIndex={hint ? 0 : undefined}
		>
			<MetaGlyph part={part} />
			<span
				className={cn(
					part.truncate ? "max-w-[10rem] truncate" : "whitespace-nowrap",
					!part.danger && part.tint,
					part.danger &&
						"text-error line-through decoration-2 decoration-error/80",
				)}
			>
				{part.value}
			</span>
		</span>
	);
	if (!hint) {
		return chip;
	}
	return (
		<Tooltip content={hint} side="top">
			{chip}
		</Tooltip>
	);
}

function EntryCardMetaShelf({
	cardLevel,
	parts,
	singleLine,
}: {
	cardLevel: number;
	parts: EntryCardMetaPart[];
	singleLine?: boolean;
}) {
	return (
		// Recessed meta shelf: full-bleed to the card's bottom + side edges (negative
		// margins MUST match the card's px-3.5/py-3), split off by a hairline, and
		// stepped DOWN one surface so it reads as a ledge under the card body.
		// `singleLine` locks the strip to one row — chips that overflow scroll
		// horizontally (auto-hiding scrollbar) rather than wrapping to a second line.
		<div
			className={cn(
				"-mx-3.5 -mb-3 flex items-center border-divider border-t px-3.5 pt-2.5 pb-3 text-foreground-secondary text-xs-tight",
				singleLine
					? "gap-x-3 overflow-x-auto whitespace-nowrap"
					: "flex-wrap gap-x-3 gap-y-1",
				surfaceBg(Math.max(cardLevel - 1, 1)),
			)}
		>
			{parts.map((part) => (
				<EntryCardMetaItem key={part.key} part={part} />
			))}
		</div>
	);
}

/**
 * Kind identity for a card: a slim tinted rail hugging the card's leading edge
 * (spanning body AND footer shelf) so the card type reads at the card level —
 * not as one more chip crowding the meta strip. `label` is announced to screen
 * readers in place of the visible kind text the rail replaces.
 */
export interface EntryCardAccent {
	label: string;
	/** bg-* tint class for the rail (e.g. `bg-history-stt`). */
	railClass: string;
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
	accent,
	children,
	footer,
	singleLine,
}: {
	/** Kind-colored edge rail typing the whole card (history STT/TTS/transform). */
	accent?: EntryCardAccent;
	children: ReactNode;
	footer: EntryCardMetaPart[];
	/** Keep the footer meta strip on a single line (history rows); overflow
	 *  scrolls horizontally instead of wrapping. */
	singleLine?: boolean;
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
						"relative flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border px-3.5 py-3",
						surfaceClasses(cardLevel, Math.max(cardLevel - 1, 1)),
						"transition-colors duration-150",
						surfaceHoverBg(Math.min(cardLevel + 1, 8)),
						"hover:border-border-hover",
					)}
				>
					{accent ? (
						// The rail is decorative; the sr-only text carries the kind name the
						// removed footer chip used to announce. `start-0` keeps it on the
						// leading edge under RTL; the card's overflow-hidden rounds its ends.
						<>
							<span
								aria-hidden="true"
								className={cn(
									"absolute inset-y-0 start-0 w-[3px]",
									accent.railClass,
								)}
							/>
							<span className="sr-only">{accent.label}</span>
						</>
					) : null}
					{children}
					{footer.length > 0 ? (
						<EntryCardMetaShelf
							cardLevel={cardLevel}
							parts={footer}
							singleLine={singleLine ?? false}
						/>
					) : null}
				</div>
			</SurfaceProvider>
		</div>
	);
}
