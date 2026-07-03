import { cn } from "@/shared/lib/cn";

/**
 * Shared model-card chrome — the single source of visual identity for EVERY
 * picker (STT, Ollama, OpenRouter). Lifted verbatim from the gold-standard
 * `SttModelCard` so all three render the identical card.
 *
 * Each card is a solid, elevated *specimen*: a real surface step (surface-3
 * over the surface-2 popup) with a tinted depth shadow, so it reads as a
 * discrete object. Hover deepens the shadow without moving the card; press
 * settles it with a subtle scale (12-principles: transform/opacity only,
 * ease-out ≤150ms, motion-reduce guarded).
 */
export const CARD_BASE = cn(
	// `group` enables the hover-reveal of `group-hover:` descendants (e.g. the
	// Ollama delete button) — without it that button stays invisible/unclickable.
	"group relative mx-1.5 my-1.5 flex cursor-pointer flex-col gap-2.5 overflow-hidden rounded-lg px-3.5 py-3 outline-none",
	"border border-border bg-surface-3 shadow-surface-2",
	"[content-visibility:auto] [contain-intrinsic-size:0_136px]",
	"transition-[transform,border-color,background-color,box-shadow] duration-150 ease-out",
	"hover:border-border-hover hover:bg-surface-4 hover:shadow-surface-3",
	"active:scale-[0.99]",
	"data-[highlighted]:border-border-hover data-[highlighted]:bg-surface-4 data-[highlighted]:shadow-surface-3",
	"motion-reduce:transition-none motion-reduce:active:scale-100",
);

/** Active selection: the fill warms to a Docker-blue tint and gains a ring.
 *  Hover/highlight keep the accent rather than falling back to the neutral
 *  surface-4 of {@link CARD_BASE}. */
export const CARD_SELECTED = cn(
	"border-accent/55 bg-accent/[0.09] shadow-surface-3 ring-1 ring-accent/25",
	"hover:border-accent/70 hover:bg-accent/[0.12]",
	"data-[highlighted]:border-accent/70 data-[highlighted]:bg-accent/[0.12]",
);

/** Softer variant: a bundle primary owns the selected variant but isn't itself
 *  the active id. Lighter than {@link CARD_SELECTED} so the actually-selected
 *  sibling still wins the eye. */
export const CARD_SELECTED_VARIANT = cn(
	"border-accent/30 bg-accent/[0.05]",
	"hover:border-accent/45 hover:bg-accent/[0.08]",
	"data-[highlighted]:border-accent/45 data-[highlighted]:bg-accent/[0.08]",
);

/** Nested siblings (revealed under a chevron) recess to surface-2 so they read
 *  as tucked *under* their surface-3 primary. */
export const CARD_NESTED = cn(
	"bg-surface-2 shadow-surface-1",
	"hover:bg-surface-3",
	"data-[highlighted]:bg-surface-3",
);

/** Desaturates a broken/unavailable card and parks the hover surface change (a
 *  non-selectable card shouldn't feel tactile). */
export const CARD_UNAVAILABLE = cn(
	"cursor-not-allowed opacity-55",
	"hover:border-border hover:bg-surface-3 hover:shadow-surface-2",
);

/** The recessed "how to get it" shelf: a subtly-darkened ledge that bleeds to
 *  the card's bottom + side edges (negative margins MUST match the card's own
 *  px-3.5/py-3), split from the identity header by a full-bleed hairline. */
export const RECESSED_SHELF_CLASSES =
	"-mx-3.5 -mb-3 border-divider border-t bg-foreground/[0.02] px-3.5 pt-2.5 pb-3";

/** Sticky section/group header chrome — identical across every picker so the
 *  headers dock the same way while scrolling. It lifts to surface-5 so it reads
 *  as a real control/header layer above the settings-card substrate. */
export const GROUP_HEADER_CLASSES = cn(
	"sticky top-0 z-raised flex h-8 shrink-0 items-center gap-2 px-3 py-0",
	"border-border/70 border-b bg-surface-5/95 shadow-surface-3 ring-1 ring-divider/70 ring-inset",
	"backdrop-blur-md",
);

/** Covers only the native scrollbar gutter beside a docked group header. The
 *  list keeps native scrolling, but the bar visually starts below the header. */
export const GROUP_HEADER_SCROLLBAR_MASK_CLASSES = cn(
	"pointer-events-none absolute top-0 end-0 z-overlay h-8 w-3",
	"border-border/70 border-b bg-surface-5/95 shadow-surface-3 ring-1 ring-divider/70 ring-inset",
	"backdrop-blur-md",
);
