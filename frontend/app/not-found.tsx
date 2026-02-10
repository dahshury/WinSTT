export default function NotFound() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				height: "100%",
				gap: "16px",
				padding: "32px",
				fontFamily: "var(--font-sans)",
			}}
		>
			<div
				style={{
					width: "48px",
					height: "48px",
					borderRadius: "var(--radius-lg)",
					backgroundColor: "var(--color-surface-elevated)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					fontSize: "20px",
					color: "var(--color-foreground-muted)",
				}}
			>
				?
			</div>
			<h2
				style={{
					fontSize: "16px",
					fontWeight: 600,
					color: "var(--color-foreground)",
					margin: 0,
				}}
			>
				Page not found
			</h2>
			<p
				style={{
					fontSize: "13px",
					color: "var(--color-foreground-muted)",
					textAlign: "center",
					maxWidth: "360px",
					margin: 0,
				}}
			>
				The page you're looking for doesn't exist.
			</p>
		</div>
	);
}
