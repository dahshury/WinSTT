import type { ReactNode } from "react";

export interface SettingRowProps {
	label: string;
	description?: string;
	children: ReactNode;
}

export function SettingRow({ label, description, children }: SettingRowProps) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: "16px",
				padding: "6px 0",
				borderColor: "var(--color-border)",
			}}
		>
			<div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
				<span
					style={{
						color: "var(--color-text-primary)",
						fontFamily: "var(--font-sans)",
						fontSize: "13px",
						fontWeight: 500,
					}}
				>
					{label}
				</span>
				{description && (
					<span
						style={{
							color: "var(--color-text-dim)",
							fontFamily: "var(--font-sans)",
							fontSize: "12px",
						}}
					>
						{description}
					</span>
				)}
			</div>
			<div style={{ flexShrink: 0 }}>{children}</div>
		</div>
	);
}
