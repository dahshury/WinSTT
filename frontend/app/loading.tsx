export default function Loading() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				height: "100%",
			}}
		>
			<div
				style={{
					width: "24px",
					height: "24px",
					border: "2px solid var(--color-border)",
					borderTopColor: "var(--color-accent)",
					borderRadius: "50%",
					animation: "spin 600ms linear infinite",
				}}
			/>
			<style>{"@keyframes spin { to { transform: rotate(360deg) } }"}</style>
		</div>
	);
}
