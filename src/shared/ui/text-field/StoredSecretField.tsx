import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/shared/lib/cn";
import { TextField } from "./TextField";

const STORED_SECRET_VALUE = "********";

export function StoredSecretField({
	className,
	...props
}: Omit<ComponentPropsWithoutRef<"input">, "onChange" | "type" | "value">) {
	return (
		<TextField
			{...props}
			className={cn("cursor-not-allowed text-foreground-muted", className)}
			disabled
			readOnly
			type="password"
			value={STORED_SECRET_VALUE}
		/>
	);
}
