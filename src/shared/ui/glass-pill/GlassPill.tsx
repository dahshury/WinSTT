import type { ReactNode } from "react";
import { cn } from "@/shared/lib/cn";

/**
 * The frosted-glass surface shared by every WinSTT floating pill (the recording
 * overlay pill/bubble, the TTS island, and the tray-indicator mode pill). Single
 * source of truth so they all read as the same material.
 *
 * `GLASS_SURFACE` is the gradient + inset ring + backdrop blur; `BUBBLE_SHADOW` /
 * `CHIP_SHADOW` are the two elevation shadows (rounded bubble vs. pill chip).
 */
export const GLASS_SURFACE =
	"bg-gradient-to-b from-surface-3/65 to-surface-1/92 ring-1 ring-overlay-foreground/[0.08] ring-inset backdrop-blur-md backdrop-saturate-150";
export const BUBBLE_SHADOW = "shadow-glass-pill";
export const CHIP_SHADOW = "shadow-glass-chip";

/** The faint accent hairline drawn across the top edge of a glass bubble. */
function GlassHairline() {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent via-accent-hairline to-transparent"
		/>
	);
}

/**
 * A rounded frosted-glass bubble — the same shell the recording overlay uses for
 * its text bubble, exposed as a reusable primitive. Renders the glass surface,
 * bubble shadow, and top accent hairline; callers supply padding/gap via
 * `className` and the contents as children.
 */
export function GlassPill({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"relative inline-flex items-center overflow-hidden rounded-2xl",
				GLASS_SURFACE,
				BUBBLE_SHADOW,
				className,
			)}
		>
			<GlassHairline />
			{children}
		</div>
	);
}
