import type { ReactNode } from "react";

export interface SettingRowProps {
	label: string;
	description?: string;
	children: ReactNode;
}

export function SettingRow({ label, description, children }: SettingRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-1.5">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="font-medium font-sans text-[13px] text-foreground">{label}</span>
				{description && (
					<span className="font-sans text-[12px] text-foreground-dim">{description}</span>
				)}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}
