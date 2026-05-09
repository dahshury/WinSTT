"use client";

import { type CSSProperties, useEffect } from "react";
import { Button } from "@/shared/ui/button";

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
	backgroundColor: "var(--color-error-dim)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontSize: "20px",
};

const headingStyle: CSSProperties = {
	fontSize: "16px",
	fontWeight: 600,
	color: "var(--color-text-primary)",
	margin: 0,
};

const bodyStyle: CSSProperties = {
	fontSize: "13px",
	color: "var(--color-text-muted)",
	textAlign: "center",
	maxWidth: "360px",
	margin: 0,
	fontFamily: "var(--font-mono)",
};

const buttonStyle: CSSProperties = {
	marginTop: "8px",
	padding: "8px 20px",
	fontSize: "13px",
	fontWeight: 500,
	fontFamily: "var(--font-mono)",
	color: "var(--color-text-primary)",
	backgroundColor: "var(--color-bg-elevated)",
	border: "1px solid var(--color-border)",
	borderRadius: "var(--radius-sm)",
	transition: "background-color 150ms, border-color 150ms",
};

function applyButtonRest(el: HTMLButtonElement): void {
	Object.assign(el.style, {
		backgroundColor: "var(--color-bg-elevated)",
		borderColor: "var(--color-border)",
	});
}

function applyButtonHover(el: HTMLButtonElement): void {
	Object.assign(el.style, {
		backgroundColor: "var(--color-bg-hover)",
		borderColor: "var(--color-border-hover)",
	});
}

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
		<div style={containerStyle}>
			<div style={iconStyle}>!</div>

			<h2 style={headingStyle}>Something went wrong</h2>

			<p style={bodyStyle}>{error.message || "An unexpected error occurred"}</p>

			<Button
				onBlur={(e) => applyButtonRest(e.currentTarget)}
				onClick={reset}
				onFocus={(e) => applyButtonHover(e.currentTarget)}
				onMouseOut={(e) => applyButtonRest(e.currentTarget)}
				onMouseOver={(e) => applyButtonHover(e.currentTarget)}
				style={buttonStyle}
			>
				Try again
			</Button>
		</div>
	);
}
