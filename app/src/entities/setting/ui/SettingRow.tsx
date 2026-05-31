import type { ReactNode } from "react";

export interface SettingRowProps {
	children: ReactNode;
	description?: string;
	label: string;
}

export function SettingRow({ label, description, children }: SettingRowProps) {
	return (
		<div className="flex items-center justify-between gap-4 py-1.5">
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="font-medium font-sans text-body text-foreground">{label}</span>
				{description && (
					<span className="font-sans text-body-sm text-foreground-dim">{description}</span>
				)}
			</div>
			<div className="shrink-0">{children}</div>
		</div>
	);
}
