import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentPropsWithoutRef, type Ref, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { TextField } from "./TextField";

export interface PasswordFieldProps extends Omit<ComponentPropsWithoutRef<"input">, "type"> {
	error?: boolean;
	hideLabel?: string;
	ref?: Ref<HTMLInputElement>;
	revealLabel?: string;
}

export function PasswordField({
	className,
	error,
	hideLabel = "Hide",
	ref,
	revealLabel = "Show",
	...props
}: PasswordFieldProps) {
	const [revealed, setRevealed] = useState(false);
	return (
		<div className="relative w-full">
			<TextField
				className={cn("pr-9", className)}
				error={error ?? false}
				type={revealed ? "text" : "password"}
				{...(ref !== undefined && { ref })}
				{...props}
			/>
			<button
				aria-label={revealed ? hideLabel : revealLabel}
				aria-pressed={revealed}
				className="absolute inset-y-0 right-0 flex w-8 items-center justify-center rounded-sm text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onClick={() => setRevealed((v) => !v)}
				type="button"
			>
				<HugeiconsIcon icon={revealed ? ViewOffIcon : ViewIcon} size={14} />
			</button>
		</div>
	);
}
