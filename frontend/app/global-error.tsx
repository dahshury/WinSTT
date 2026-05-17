"use client";

import { type CSSProperties, useEffect } from "react";
import { Button } from "@/shared/ui/button";

const containerStyle: CSSProperties = {
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	height: "100vh",
	gap: "16px",
	padding: "32px",
	fontFamily: "system-ui, -apple-system, sans-serif",
	backgroundColor: "#09090b",
	color: "#fafafa",
};

const iconStyle: CSSProperties = {
	width: "48px",
	height: "48px",
	borderRadius: "12px",
	backgroundColor: "#450a0a",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	fontSize: "20px",
};

const headingStyle: CSSProperties = { fontSize: "16px", fontWeight: 600, margin: 0 };

const bodyStyle: CSSProperties = {
	fontSize: "13px",
	color: "#52525b",
	textAlign: "center",
	maxWidth: "360px",
	margin: 0,
};

const buttonStyle: CSSProperties = {
	marginTop: "8px",
	padding: "8px 20px",
	fontSize: "13px",
	fontWeight: 500,
	color: "#fafafa",
	backgroundColor: "#1f1f23",
	border: "1px solid #27272a",
	borderRadius: "5px",
};

export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	useEffect(() => {
		// Console.error is captured by main's `console-message` listener and
		// flows into Sentry there. No renderer-side Sentry SDK by design.
		console.error("[GlobalError]", error);
	}, [error]);

	return (
		<html lang="en">
			<body>
				<div style={containerStyle}>
					<div style={iconStyle}>!</div>
					<h2 style={headingStyle}>Something went wrong</h2>
					<p style={bodyStyle}>{error.message || "A critical error occurred"}</p>
					<Button onClick={reset} style={buttonStyle}>
						Try again
					</Button>
				</div>
			</body>
		</html>
	);
}
