import type { ComponentProps } from "react";
import { cn } from "@/shared/lib/cn";

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
		<>
			<style>{`
				@keyframes loading-ui-pulse-dot {
					0%,
					100% {
						transform: scale(1);
						opacity: 0.8;
					}

					50% {
						transform: scale(1.5);
						opacity: 1;
					}
				}
			`}</style>
			<span
				aria-hidden={ariaHidden ?? (hasAccessibleName ? undefined : true)}
				aria-label={ariaLabel}
				aria-labelledby={ariaLabelledBy}
				className={cn("inline-block rounded-full bg-current", className)}
				data-slot="pulse-dot"
				role={role ?? (hasAccessibleName ? "status" : undefined)}
				style={{
					animation:
						"loading-ui-pulse-dot var(--duration, 1.2s) ease-in-out infinite",
					...style,
				}}
				{...props}
			/>
		</>
	);
}
