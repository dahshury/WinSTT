import type { ComponentProps } from "react";
import { ThinkingOrb } from "thinking-orbs";
import { cn } from "@/shared/lib/cn";

/**
 * The app's shared loading indicator. Formerly a scale-pulsing dot; now renders
 * the `searching` thinking orb (thinking-orbs) so every in-flight state across
 * the app shows the same living animation instead of a blinking dot.
 *
 * The API is unchanged: callers keep sizing and positioning it through
 * `className` (`size-1.5`, `absolute`, `text-*`, …). The orb ships at a fixed
 * 20px preset, so we let it fill the caller-sized box at `width/height: 100%` —
 * the caller's `style` spreads last inside the component and overrides its
 * intrinsic box, while the canvas keeps its 40px backing store and downscales
 * crisply into the tiny inline footprints these badges use. `text-*` color
 * classes no longer tint it — the orb paints its own theme-aware ink.
 */
export function PulseDot({
	className,
	role,
	style,
	"aria-hidden": ariaHidden,
	"aria-label": ariaLabel,
	"aria-labelledby": ariaLabelledBy,
	...props
}: ComponentProps<"span">) {
	const hasAccessibleName =
		ariaLabel !== undefined || ariaLabelledBy !== undefined;

	return (
		<span
			aria-hidden={ariaHidden ?? (hasAccessibleName ? undefined : true)}
			aria-label={ariaLabel}
			aria-labelledby={ariaLabelledBy}
			className={cn("relative inline-block leading-none", className)}
			data-slot="pulse-dot"
			role={role ?? (hasAccessibleName ? "status" : undefined)}
			style={style}
			{...props}
		>
			<ThinkingOrb
				aria-hidden
				size={20}
				state="searching"
				style={{ width: "100%", height: "100%", display: "block" }}
			/>
		</span>
	);
}
