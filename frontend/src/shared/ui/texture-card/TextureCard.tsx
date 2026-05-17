"use client";

import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { cn } from "@/shared/lib/cn";
import { SurfaceProvider, surfaceBg, useSurface } from "@/shared/lib/surface";

/**
 * Card primitive inspired by cult-ui's TextureCard. Three regions stacked
 * vertically with deliberate visual contrast:
 *
 *   ┌──────────────────────────────┐ ← outer ring + inset highlight
 *   │  Header (body bg)            │
 *   ├──────────────────────────────┤ ← embossed separator (dark + light)
 *   │  Body   (body bg)            │
 *   ├──────────────────────────────┤ ← embossed separator
 *   │  Footer (brighter bg)        │ ← strong contrast strip
 *   └──────────────────────────────┘
 *
 * The card adapts to the current substrate (via `useSurface`) so a card
 * dropped on `surface-2` lifts its body to `surface-3` and its footer to
 * `surface-4`, while the substrate it advertises downstream is the body
 * level — anything nested elevates from there.
 *
 * Pieces are individually exported so consumers can compose only the
 * regions they need; the `TextureSeparator` is the embossed-line primitive
 * for use *outside* the card too (between repeated rows etc.).
 */
export interface TextureCardProps extends ComponentPropsWithoutRef<"section"> {
	/** Lift the body N steps above the current substrate. Footer always sits one step above the body. */
	offset?: number;
	ref?: Ref<HTMLElement>;
}

export function TextureCard({ offset = 1, className, children, ref, ...props }: TextureCardProps) {
	const substrate = useSurface();
	const bodyLevel = Math.min(substrate + offset, 7);
	return (
		<SurfaceProvider value={bodyLevel}>
			<section
				className={cn(
					"overflow-hidden rounded-xl ring-1 ring-divider-strong",
					surfaceBg(bodyLevel),
					"shadow-surface-3",
					className
				)}
				ref={ref}
				{...props}
			>
				{children}
			</section>
		</SurfaceProvider>
	);
}

/**
 * Embossed separator — a 2px stack of a darker hairline above a lighter
 * highlight below, giving the line an etched/recessed feel rather than a
 * single flat stroke. Spans the full width of its parent.
 */
export function TextureSeparator({ className }: { className?: string }) {
	return (
		<div aria-hidden="true" className={cn("relative h-[2px] w-full", className)}>
			<div className="absolute inset-x-0 top-0 h-px bg-surface-1/80" />
			<div className="absolute inset-x-0 top-px h-px bg-foreground/[0.04]" />
		</div>
	);
}

export interface TextureCardRegionProps extends ComponentPropsWithoutRef<"div"> {
	children?: ReactNode;
}

/** Top region — typically holds the section title + icon + trailing toggle. */
export function TextureCardHeader({ className, children, ...props }: TextureCardRegionProps) {
	return (
		<header className={cn("flex items-center gap-3 px-5 pt-4 pb-4", className)} {...props}>
			{children}
		</header>
	);
}

/** Middle region — the main content (form rows, controls, etc.). */
export function TextureCardBody({ className, children, ...props }: TextureCardRegionProps) {
	return (
		<div className={cn("px-5 py-4", className)} {...props}>
			{children}
		</div>
	);
}

/**
 * Bottom region — a brighter strip that provides the visual close to the
 * card. Lifts one surface step above the body so it visibly contrasts
 * (the user's specific ask: "contrast between footers and surroundings").
 * Uses dimmer text by default so it reads as supporting metadata.
 */
export function TextureCardFooter({ className, children, ...props }: TextureCardRegionProps) {
	const bodyLevel = useSurface();
	const footerLevel = Math.min(bodyLevel + 1, 8);
	return (
		<div
			className={cn(
				surfaceBg(footerLevel),
				"px-5 py-2.5 text-body-sm text-foreground-muted",
				className
			)}
			{...props}
		>
			{children}
		</div>
	);
}
