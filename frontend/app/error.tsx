"use client";

import { useEffect } from "react";

export default function RootError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		console.error("[RootError]", error);
	}, [error]);

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
					backgroundColor: "var(--color-error-dim)",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					fontSize: "20px",
				}}
			>
				!
			</div>

			<h2
				style={{
					fontSize: "16px",
					fontWeight: 600,
					color: "var(--color-text-primary)",
					margin: 0,
				}}
			>
				Something went wrong
			</h2>

			<p
				style={{
					fontSize: "13px",
					color: "var(--color-text-muted)",
					textAlign: "center",
					maxWidth: "360px",
					margin: 0,
					fontFamily: "var(--font-mono)",
				}}
			>
				{error.message || "An unexpected error occurred"}
			</p>

			<button
				onBlur={(e) => {
					e.currentTarget.style.backgroundColor = "var(--color-bg-elevated)";
					e.currentTarget.style.borderColor = "var(--color-border)";
				}}
				onClick={reset}
				onFocus={(e) => {
					e.currentTarget.style.backgroundColor = "var(--color-bg-hover)";
					e.currentTarget.style.borderColor = "var(--color-border-hover)";
				}}
				onMouseOut={(e) => {
					e.currentTarget.style.backgroundColor = "var(--color-bg-elevated)";
					e.currentTarget.style.borderColor = "var(--color-border)";
				}}
				onMouseOver={(e) => {
					e.currentTarget.style.backgroundColor = "var(--color-bg-hover)";
					e.currentTarget.style.borderColor = "var(--color-border-hover)";
				}}
				style={{
					marginTop: "8px",
					padding: "8px 20px",
					fontSize: "13px",
					fontWeight: 500,
					fontFamily: "var(--font-mono)",
					color: "var(--color-text-primary)",
					backgroundColor: "var(--color-bg-elevated)",
					border: "1px solid var(--color-border)",
					borderRadius: "var(--radius-sm)",
					cursor: "pointer",
					transition: "background-color 150ms, border-color 150ms",
				}}
				type="button"
			>
				Try again
			</button>
		</div>
	);
}
