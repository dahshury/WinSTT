import type { ReactNode } from "react";

export interface SettingSectionProps {
	title: string;
	children: ReactNode;
}

export function SettingSection({ title, children }: SettingSectionProps) {
	return (
		<div style={{ marginBottom: "16px" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: "8px",
					padding: "0 4px",
					marginBottom: "6px",
				}}
			>
				<h3
					style={{
						color: "var(--color-accent)",
						fontFamily: "var(--font-mono)",
						fontSize: "11px",
						fontWeight: 600,
						letterSpacing: "0.1em",
						textTransform: "uppercase",
					}}
				>
					{title}
				</h3>
				<div style={{ height: "1px", flex: 1, backgroundColor: "var(--color-border)" }} />
			</div>
			<div
				style={{
					backgroundColor: "var(--color-bg-secondary)",
					border: "1px solid var(--color-border)",
					borderRadius: "8px",
					padding: "4px 12px",
				}}
			>
				{children}
			</div>
		</div>
	);
}
