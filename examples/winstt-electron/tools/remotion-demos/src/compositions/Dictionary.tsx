import { useCurrentFrame } from "remotion";
import { Box, C, Caption, envelope, ramp, Stage } from "../theme";

/**
 * Dictionary correction — a BEFORE→AFTER, two-column crossfade across DUR.
 * A 2-state scene that pivots at the midpoint (~frame 70): the model mis-hears
 * a tricky-but-familiar word ("Worcestershire") and the dictionary's
 * replacement pair fixes the spelling deterministically.
 * Both columns occupy fixed slots — only opacity/transform animate (no shift).
 */
export function Dictionary() {
	const f = useCurrentFrame();

	const cross = ramp(f, 64, 78);
	const beforeOp = 1 - cross * 0.55;
	const wrongOp = 1 - cross * 0.6;
	const afterOp = 0.25 + cross * 0.75;
	const pop = ramp(f, 70, 84);
	const afterScale = 0.95 + cross * 0.11 - pop * 0.06;
	const arrowShift = cross * 6;
	const arrowOp = 0.4 + cross * 0.6;
	const labelOp = envelope(f, 4, 14, 9999, 9999);

	const label = { fontFamily: C.mono, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: C.fgMuted, opacity: labelOp } as const;

	return (
		<Stage tag="Dictionary">
			<div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10 }}>
				{/* HEARD (before) — the model's phonetic mis-transcription */}
				<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, opacity: beforeOp }}>
					<span style={label}>Heard</span>
					<Box style={{ fontSize: 14 }}>
						<span style={{ whiteSpace: "nowrap" }}>
							a dash of{" "}
							<span style={{ color: C.error, textDecoration: "line-through", opacity: wrongOp }}>wuster·sher</span>{" "}
							sauce
						</span>
					</Box>
				</div>

				{/* ARROW */}
				<div style={{ display: "flex", alignItems: "center", height: 40, paddingTop: 22 }}>
					<span style={{ fontSize: 22, color: C.accent, opacity: arrowOp, transform: `translateX(${arrowShift}px)` }}>→</span>
				</div>

				{/* PASTED (after) — the correct spelling */}
				<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8, opacity: afterOp, transform: `scale(${afterScale})`, transformOrigin: "left center" }}>
					<span style={label}>Pasted</span>
					<Box style={{ fontSize: 14, borderColor: cross > 0.5 ? "rgba(34,197,94,0.4)" : C.border }}>
						<span style={{ whiteSpace: "nowrap" }}>
							a dash of{" "}
							<span style={{ color: C.success, fontWeight: 600 }}>Worcestershire</span>{" "}
							sauce
						</span>
					</Box>
				</div>
			</div>
			<Caption items={["Heard", "Corrected ✓"]} />
		</Stage>
	);
}
