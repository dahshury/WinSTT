import type { MouseEvent, PointerEvent, ReactElement, ReactNode } from "react";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { DialogActionButton } from "@/shared/ui/dialog";

type DownloadButtonEvent =
	| MouseEvent<HTMLButtonElement>
	| PointerEvent<HTMLButtonElement>;

function stopDownloadButtonPropagation(event: DownloadButtonEvent): void {
	event.stopPropagation();
}

function downloadButtonHandlers(onAction: () => void) {
	return {
		onClick: (event: MouseEvent<HTMLButtonElement>) => {
			event.preventDefault();
			event.stopPropagation();
			onAction();
		},
		onMouseDown: stopDownloadButtonPropagation,
		onPointerDown: stopDownloadButtonPropagation,
	};
}

export function DownloadActionButton({
	defaultClassName,
	dialogAppearance,
	icon,
	label,
	onAction,
	sizeClassName,
	variant,
}: {
	defaultClassName: string;
	dialogAppearance: boolean;
	icon: ReactNode;
	label: string;
	onAction: () => void;
	sizeClassName: string;
	variant: "neutral" | "accent";
}): ReactElement {
	const handlers = downloadButtonHandlers(onAction);
	if (dialogAppearance) {
		return (
			<DialogActionButton
				className={sizeClassName}
				variant={variant}
				{...handlers}
			>
				{icon}
				<span>{label}</span>
			</DialogActionButton>
		);
	}
	return (
		<Button className={cn(defaultClassName, sizeClassName)} {...handlers}>
			{icon}
			<span>{label}</span>
		</Button>
	);
}
