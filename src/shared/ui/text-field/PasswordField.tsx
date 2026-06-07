import { Button as BaseButton } from "@base-ui/react/button";
import { ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ComponentPropsWithoutRef, type Ref, useState } from "react";
import { cn } from "@/shared/lib/cn";
import { IconSwap } from "@/shared/ui/animated-value";
import { TextField } from "./TextField";

export interface PasswordFieldProps
	extends Omit<ComponentPropsWithoutRef<"input">, "type"> {
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
	const [flashKey, setFlashKey] = useState(0);
	const handleToggle = () => {
		setRevealed((v) => !v);
		setFlashKey((v) => v + 1);
	};
	return (
		<div className="relative w-full overflow-hidden rounded-lg">
			<TextField
				className={cn("pr-9", className)}
				error={error ?? false}
				type={revealed ? "text" : "password"}
				{...(ref !== undefined && { ref })}
				{...props}
			/>
			{flashKey > 0 ? (
				<span aria-hidden="true" className="t-secret-reveal" key={flashKey} />
			) : null}
			<BaseButton
				aria-label={revealed ? hideLabel : revealLabel}
				aria-pressed={revealed}
				className="absolute inset-y-0 right-0 z-raised flex w-8 items-center justify-center rounded-r-lg text-foreground-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
				onClick={handleToggle}
				type="button"
			>
				<IconSwap
					a={<HugeiconsIcon icon={ViewIcon} size={14} />}
					b={<HugeiconsIcon icon={ViewOffIcon} size={14} />}
					state={revealed ? "b" : "a"}
				/>
			</BaseButton>
		</div>
	);
}
