import { useCurrentFrame } from "remotion";
import { Bars, Box, C, Caption, envelope, MODE_COLOR, Stage, Typed } from "../theme";

/**
 * Wake-word composition. 3 beats over DUR=150 frames (5s):
 *   0–50    Say the wake word — a rounded "Alexa" bubble fades in
 *   50–100  Listening…        — a pulsing wake-word ring + 🎙 glyph + bars
 *   100–150 Pasted            — text types into a Box
 * Reserve a fixed slot for every element (animate opacity, not layout) so
 * nothing shifts as beats change. Uses the wake-word accent for ring/glow.
 */
export function Wakeword() {
	const f = useCurrentFrame();
	const wake = MODE_COLOR.wakeword; // #f97316

	const bubbleOp = envelope(f, 2, 8, 44, 50);
	const ringOp = envelope(f, 52, 60, 94, 100);
	const boxOp = envelope(f, 100, 110, 9999, 9999);

	// Pulse drives the ring scale + glow while listening.
	const pulse = 0.5 + 0.5 * Math.sin(f * 0.32);
	const ringScale = 0.92 + 0.12 * pulse;
	const ringGlow = 8 + 18 * pulse;

	return (
		<Stage tag="Wake Word">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
				{/* Beat 1: wake-word bubble */}
				<div style={{ height: 40, display: "flex", alignItems: "center", opacity: bubbleOp }}>
					<div
						style={{
							display: "inline-flex",
							alignItems: "center",
							padding: "8px 18px",
							borderRadius: 999,
							background: C.surface1,
							border: `1px solid ${wake}`,
							color: C.fg,
							fontSize: 18,
							fontWeight: 600,
							letterSpacing: 0.3,
							boxShadow: `0 0 24px -6px ${wake}`,
						}}
					>
						“Alexa”
					</div>
				</div>

				{/* Beat 2: pulsing listening ring + bars */}
				<div style={{ height: 64, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, opacity: ringOp }}>
					<div
						style={{
							width: 46,
							height: 46,
							borderRadius: "50%",
							border: `2px solid ${wake}`,
							display: "grid",
							placeItems: "center",
							fontSize: 20,
							color: wake,
							background: "rgba(249,115,22,0.08)",
							boxShadow: `0 0 ${ringGlow}px -2px ${wake}`,
							opacity: 0.65 + 0.35 * pulse,
							transform: `scale(${ringScale})`,
						}}
					>
						🎙
					</div>
					<div style={{ height: 16, display: "flex", alignItems: "center" }}>
						<Bars count={5} color={wake} height={16} active />
					</div>
				</div>

				{/* Beat 3: pasted text */}
				<div style={{ height: 44, display: "flex", alignItems: "center", opacity: boxOp }}>
					<Box>
						<Typed text="Set a timer for ten minutes." from={104} dur={24} />
					</Box>
				</div>
			</div>
			<Caption items={["Say the wake word", "Listening…", "Pasted"]} />
		</Stage>
	);
}
