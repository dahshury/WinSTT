import { cn } from "@/shared/lib/cn";

/**
 * Shared model-card chrome — the single source of visual identity for EVERY
 * picker (STT, Ollama, OpenRouter). Lifted verbatim from the gold-standard
 * `SttModelCard` so all three render the identical card.
 *
 * Each card is a solid, elevated *specimen*: a real surface step (surface-3
 * over the surface-2 popup) with a tinted depth shadow, so it reads as a
 * discrete object. Hover lifts it 1px and deepens the shadow; press settles it
 * back with a subtle scale (12-principles: transform/opacity only, ease-out
 * ≤150ms, motion-reduce guarded).
 */
export const CARD_BASE = cn(
	// `group` enables the hover-reveal of `group-hover:` descendants (e.g. the
	// Ollama delete button) — without it that button stays invisible/unclickable.
	"group relative mx-2 my-1.5 flex cursor-pointer flex-col gap-2.5 overflow-hidden rounded-lg px-3.5 py-3 outline-none",
	"border border-border bg-surface-3 shadow-surface-2",
	"transition-[transform,border-color,background-color,box-shadow] duration-150 ease-out",
	"hover:-translate-y-px hover:border-border-hover hover:bg-surface-4 hover:shadow-surface-3",
	"active:translate-y-0 active:scale-[0.99]",
	"data-[highlighted]:border-border-hover data-[highlighted]:bg-surface-4 data-[highlighted]:shadow-surface-3",
	"motion-reduce:transition-none motion-reduce:active:scale-100 motion-reduce:hover:translate-y-0"
);

/** Active selection: the fill warms to a Docker-blue tint and gains a ring.
 *  Hover/highlight keep the accent rather than falling back to the neutral
 *  surface-4 of {@link CARD_BASE}. */
export const CARD_SELECTED = cn(
	"border-accent/55 bg-accent/[0.09] shadow-surface-3 ring-1 ring-accent/25",
	"hover:border-accent/70 hover:bg-accent/[0.12]",
	"data-[highlighted]:border-accent/70 data-[highlighted]:bg-accent/[0.12]"
);

/** Softer variant: a bundle primary owns the selected variant but isn't itself
 *  the active id. Lighter than {@link CARD_SELECTED} so the actually-selected
 *  sibling still wins the eye. */
export const CARD_SELECTED_VARIANT = cn(
	"border-accent/30 bg-accent/[0.05]",
	"hover:border-accent/45 hover:bg-accent/[0.08]",
	"data-[highlighted]:border-accent/45 data-[highlighted]:bg-accent/[0.08]"
);

/** Nested siblings (revealed under a chevron) recess to surface-2 so they read
 *  as tucked *under* their surface-3 primary. */
export const CARD_NESTED = cn(
	"bg-surface-2 shadow-surface-1",
	"hover:bg-surface-3",
	"data-[highlighted]:bg-surface-3"
);

/** Desaturates a broken/unavailable card and parks the hover-lift (a
 *  non-selectable card shouldn't feel tactile) without changing dimensions. */
export const CARD_UNAVAILABLE = cn(
	"cursor-not-allowed opacity-55",
	"hover:-translate-y-0 hover:border-border hover:bg-surface-3 hover:shadow-surface-2"
);

/** The recessed "how to get it" shelf: a subtly-darkened ledge that bleeds to
 *  the card's bottom + side edges (negative margins MUST match the card's own
 *  px-3.5/py-3), split from the identity header by a full-bleed hairline. */
export const RECESSED_SHELF_CLASSES =
	"-mx-3.5 -mb-3 border-divider border-t bg-foreground/[0.02] px-3.5 pt-2.5 pb-3";

/** Sticky section/group header chrome — identical across every picker so the
 *  headers dock the same way while scrolling. */
export const GROUP_HEADER_CLASSES =
	"sticky top-0 z-raised flex items-center gap-2 border-border/60 border-b bg-surface-elevated/95 px-3 py-1.5 backdrop-blur-sm";
