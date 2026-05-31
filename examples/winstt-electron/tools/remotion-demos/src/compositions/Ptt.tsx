import { useCurrentFrame } from "remotion";
import { Bars, Box, C, Caption, envelope, Keycap, Stage, Typed } from "../theme";

/**
 * GOLD-STANDARD composition. 3 beats over DUR=150 frames (5s):
 *   0–50   Hold & speak  — keys pressed, bars dancing
 *   50–100 Release       — keys up, bars fade
 *   100–150 Pasted       — text types into a box + a success check pops
 * Reserve a fixed slot for every element (animate opacity, not layout) so
 * nothing shifts as beats change.
 */
export function Ptt() {
	const f = useCurrentFrame();
	const pressed = f < 52;
	const barsOp = envelope(f, 0, 6, 46, 54);
	const boxOp = envelope(f, 100, 110, 9999, 9999);
	const checkOp = envelope(f, 120, 128, 9999, 9999);
	return (
		<Stage tag="Push-to-Talk">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
				<div style={{ display: "inline-flex", gap: 8 }}>
					<Keycap pressed={pressed}>Ctrl</Keycap>
					<Keycap pressed={pressed}>Win</Keycap>
				</div>
				<div style={{ height: 28, display: "flex", alignItems: "center", opacity: barsOp }}>
					<Bars count={6} active />
				</div>
				<div style={{ height: 44, display: "flex", alignItems: "center", gap: 10, opacity: boxOp }}>
					<Box>
						<Typed text="Meeting at 3 today." from={104} dur={22} />
					</Box>
					<span style={{ opacity: checkOp, width: 24, height: 24, borderRadius: "50%", background: C.success, color: "#04140a", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14 }}>
						✓
					</span>
				</div>
			</div>
			<Caption items={["Hold & speak", "Release", "Pasted"]} />
		</Stage>
	);
}
