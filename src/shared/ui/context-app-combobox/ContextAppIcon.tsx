import type { ContextAppIconProps } from "./context-app-icon.types";

export function ContextAppIcon({ icon, label }: ContextAppIconProps) {
	if (icon) {
		return (
			<img
				alt=""
				className="size-4 rounded-[3px] object-contain"
				draggable={false}
				src={icon}
			/>
		);
	}
	return (
		<span className="flex size-4 items-center justify-center rounded-[3px] border border-border bg-surface-1 font-semibold text-[10px] text-foreground-muted uppercase">
			{label.trim().charAt(0) || "?"}
		</span>
	);
}
