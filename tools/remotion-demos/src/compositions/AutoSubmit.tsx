import { interpolate, useCurrentFrame } from "remotion";
import { Box, C, Caption, envelope, Keycap, Stage, Typed } from "../theme";

/**
 * Auto-submit composition. 3 beats over DUR=150 frames (5s):
 *   0–50    Dictation lands   — text types into a chat input + dim Enter keycap
 *   50–100  Auto-presses Enter — the Enter keycap flashes pressed (56–66)
 *   100–150 Message sent      — a sent bubble slides up into the top slot,
 *                               and the input clears
 * Fixed slots throughout: a sent-bubble slot up top + an input Box below.
 * Animate opacity/transform only — never layout.
 */
export function AutoSubmit() {
	const f = useCurrentFrame();
	// Enter keycap flashes pressed across 56–66.
	const pressed = f >= 56 && f <= 66;
	// Bubble appears in beat 3: slide up + fade in.
	const bubbleOp = envelope(f, 102, 112, 9999, 9999);
	const bubbleY = interpolate(f, [102, 116], [16, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
	// Input clears once the message is sent.
	const inputOp = f < 100 ? 1 : 1 - envelope(f, 100, 110, 9999, 9999);
	return (
		<Stage tag="Auto-submit">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
				<div style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "flex-end", width: 300 }}>
					<div
						style={{
							opacity: bubbleOp,
							transform: `translateY(${bubbleY}px)`,
							background: C.accent,
							color: C.accentFg,
							borderRadius: "12px 12px 3px 12px",
							padding: "8px 13px",
							fontSize: 16,
							fontWeight: 500,
							maxWidth: 240,
							boxShadow: "0 4px 18px -6px rgba(59,130,246,0.6)",
						}}
					>
						See you in five.
					</div>
				</div>
				<div style={{ height: 44, display: "flex", alignItems: "center", opacity: inputOp }}>
					<Box style={{ width: 300, justifyContent: "space-between" }}>
						<Typed text="See you in five." from={4} dur={16} />
						<span style={{ opacity: pressed ? 1 : 0.45 }}>
							<Keycap pressed={pressed}>⏎</Keycap>
						</span>
					</Box>
				</div>
			</div>
			<Caption items={["Dictation lands", "Auto-presses Enter", "Message sent"]} />
		</Stage>
	);
}
