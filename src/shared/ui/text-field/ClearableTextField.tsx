import { Button as BaseButton } from "@base-ui/react/button";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	type ChangeEvent,
	type ComponentPropsWithoutRef,
	type ReactNode,
	type Ref,
} from "react";
import { cn } from "@/shared/lib/cn";
import { TextField } from "./TextField";

type TextFieldBaseProps = Omit<
	ComponentPropsWithoutRef<typeof TextField>,
	"className" | "onChange" | "placeholder" | "value"
>;

export interface ClearableTextFieldProps extends TextFieldBaseProps {
	clearLabel: string;
	className?: string;
	leadingIcon?: ReactNode;
	onValueChange: (value: string) => void;
	placeholder?: string;
	ref?: Ref<HTMLInputElement>;
	value: string;
	wrapperClassName?: string;
}

export function ClearableTextField({
	clearLabel,
	className,
	leadingIcon,
	onValueChange,
	placeholder = "",
	ref,
	value,
	wrapperClassName,
	...rest
}: ClearableTextFieldProps) {
	const hasValue = value.length > 0;

	const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
		onValueChange(event.target.value);
	};

	const setInputRef = (node: HTMLInputElement | null) => {
		if (typeof ref === "function") {
			ref(node);
		} else if (ref) {
			ref.current = node;
		}
	};

	const clear = () => {
		if (!value) {
			return;
		}
		onValueChange("");
	};

	return (
		<div className={cn("t-clear", wrapperClassName)}>
			{leadingIcon ? (
				<span className="pointer-events-none absolute top-1/2 left-2.5 z-raised -translate-y-1/2 text-foreground-muted">
					{leadingIcon}
				</span>
			) : null}
			<TextField
				{...rest}
				className={cn(leadingIcon && "pl-8", "pr-8", className)}
				onChange={handleChange}
				placeholder={placeholder}
				ref={setInputRef}
				value={value}
			/>
			{hasValue ? (
				<BaseButton
					aria-label={clearLabel}
					className="absolute top-1/2 right-1.5 z-overlay flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-transparent text-foreground-muted outline-none transition-colors hover:bg-foreground/10 hover:text-foreground-secondary focus-visible:ring-2 focus-visible:ring-accent"
					onClick={clear}
					onMouseDown={(event) => event.preventDefault()}
					type="button"
				>
					<HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} size={12} />
				</BaseButton>
			) : null}
		</div>
	);
}
