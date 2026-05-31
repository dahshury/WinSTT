import { useCurrentFrame } from "remotion";
import { Box, C, Caption, envelope, Stage } from "../theme";

/**
 * Snippets expansion — a BEFORE→AFTER two-column crossfade across DUR.
 * You say a short, natural trigger phrase ("my address") and it expands inline
 * into the full text. The trigger is intentional shorthand (accent), not an
 * error — distinct from the Dictionary's red correction.
 * Reserve fixed slots; animate opacity only (no layout shift).
 */
export function Snippets() {
	const f = useCurrentFrame();
	const heardOp = envelope(f, 4, 12, 9999, 9999);
	const heardDim = f > 75 ? 0.5 : 1;
	const arrowOp = envelope(f, 40, 50, 9999, 9999);
	const pastedOp = envelope(f, 70, 82, 9999, 9999);

	const label = { fontFamily: C.mono, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: C.fgMuted } as const;
	const trigger = { color: "#a9c4ff", background: C.accentSoft, borderRadius: 5, padding: "1px 5px", fontWeight: 600 } as const;

	return (
		<Stage tag="Snippets">
			<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
				{/* BEFORE — the short spoken trigger */}
				<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, width: 168, opacity: heardOp * heardDim }}>
					<span style={label}>You say</span>
					<Box style={{ fontSize: 15, whiteSpace: "nowrap" }}>
						send it to <span style={trigger}>my address</span>
					</Box>
				</div>

				{/* arrow — expansion */}
				<span style={{ opacity: arrowOp, fontSize: 22, color: C.accent, lineHeight: 1, paddingTop: 22 }}>→</span>

				{/* AFTER — the full expansion */}
				<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, width: 200, opacity: pastedOp }}>
					<span style={label}>Pasted</span>
					<Box style={{ fontSize: 15, maxWidth: 196, whiteSpace: "normal", lineHeight: 1.4 }}>
						<span>
							send it to{" "}
							<span style={{ color: C.success, fontWeight: 600 }}>742 Evergreen Terrace, Springfield</span>
						</span>
					</Box>
				</div>
			</div>
			<Caption items={["You say a short trigger", "It expands inline", "Full text pasted"]} />
		</Stage>
	);
}
