/** shadcn-compatible `Skeleton` styled with WinSTT surface tokens. */
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";

export type SkeletonProps = ComponentPropsWithoutRef<"div">;

export function Skeleton({ className, ...props }: SkeletonProps) {
	return (
		<div
			className={cn("animate-pulse rounded-md bg-surface-5", className)}
			{...props}
		/>
	);
}
