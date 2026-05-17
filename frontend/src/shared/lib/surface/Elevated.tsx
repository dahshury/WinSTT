"use client";

import type { ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { cn } from "@/shared/lib/cn";
import { surfaceClasses } from "./surface-classes";
import { SurfaceProvider, useSurface } from "./surface-context";

export interface ElevatedProps extends ComponentPropsWithoutRef<"div"> {
	children?: ReactNode;
	/**
	 * Steps above the current substrate.
	 *
	 * The component's own surface level becomes `min(substrate + offset, 8)`
	 * and is re-provided to descendants via SurfaceProvider, so further
	 * nesting walks up the ladder automatically.
	 *
	 * Conventional offsets:
	 *   2 — dropdown / popover / select menu
	 *   4 — dialog / modal
	 */
	offset: number;
	ref?: Ref<HTMLDivElement>;
	/** Override for the shadow level. Defaults to the computed surface level. */
	shadowLevel?: number;
}

export function Elevated({
	offset,
	shadowLevel,
	className,
	children,
	ref,
	...props
}: ElevatedProps) {
	const substrate = useSurface();
	const level = Math.min(substrate + offset, 8);
	return (
		<SurfaceProvider value={level}>
			<div
				className={cn(surfaceClasses(level, shadowLevel ?? level), className)}
				ref={ref}
				{...props}
			>
				{children}
			</div>
		</SurfaceProvider>
	);
}
