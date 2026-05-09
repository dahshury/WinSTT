import type { CSSProperties } from "react";

const containerStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	height: "100%",
	gap: "16px",
	padding: "32px",
	fontFamily: "var(--font-sans)",
};

const iconStyle: CSSProperties = {
	width: "48px",
	height: "48px",
	borderRadius: "var(--radius-lg)",
	backgroundColor: "var(--color-surface-elevated)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontSize: "20px",
	color: "var(--color-foreground-muted)",
};

const headingStyle: CSSProperties = {
	fontSize: "16px",
	fontWeight: 600,
	color: "var(--color-foreground)",
	margin: 0,
};

const bodyStyle: CSSProperties = {
	fontSize: "13px",
	color: "var(--color-foreground-muted)",
	textAlign: "center",
	maxWidth: "360px",
	margin: 0,
};

export default function NotFound() {
	return (
		<div style={containerStyle}>
			<div style={iconStyle}>?</div>
			<h2 style={headingStyle}>Page not found</h2>
			<p style={bodyStyle}>The page you're looking for doesn't exist.</p>
		</div>
	);
}
