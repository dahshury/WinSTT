import { interpolate, useCurrentFrame } from "remotion";
import { Box, C, Caption, envelope, Keycap, Stage, ThinkingDots, Typed } from "../theme";

/**
 * LLM text transformation. 3 beats over DUR=150 frames (5s):
 *   0–50    Select any text — a selection highlight sweeps over "when ur free"
 *   50–100  Hotkey → transform — Ctrl+Shift+T flashes pressed + thinking dots
 *   100–150 Rewritten in place — the cleaned sentence types into a box
 * Reserve a fixed slot for every element (animate opacity, not layout) so
 * nothing shifts as beats change. No prior dictation — arbitrary textbox.
 */
export function LlmTransform() {
	const f = useCurrentFrame();
	// Beat 1: selection highlight strengthens accentSoft → strong blue selection.
	const selectAlpha = interpolate(f, [4, 40], [0.14, 0.45], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
	});
	const selectOp = envelope(f, 0, 6, 96, 102);
	const pressed = f >= 54 && f < 78;
	const comboOp = envelope(f, 50, 58, 96, 102);
	const dotsOp = envelope(f, 62, 70, 96, 102);
	const outOp = envelope(f, 100, 110, 9999, 9999);
	return (
		<Stage tag="LLM · Text transformation">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
				<div style={{ height: 68, display: "flex", alignItems: "center", opacity: selectOp }}>
					<Box style={{ maxWidth: 360, whiteSpace: "normal", lineHeight: 1.5, fontSize: 16 }}>
						<span>
							hey can u send the file{" "}
							<span
								style={{
									background: `rgba(59,130,246,${selectAlpha})`,
									borderRadius: 3,
									padding: "0 3px",
								}}
							>
								when ur free
							</span>
						</span>
					</Box>
				</div>
				<div style={{ height: 36, display: "flex", alignItems: "center", gap: 14 }}>
					<span style={{ display: "inline-flex", gap: 8, opacity: comboOp }}>
						<Keycap pressed={pressed}>Ctrl</Keycap>
						<Keycap pressed={pressed}>Shift</Keycap>
						<Keycap pressed={pressed}>T</Keycap>
					</span>
					<span style={{ display: "inline-flex", alignItems: "center", opacity: dotsOp }}>
						<ThinkingDots />
					</span>
				</div>
				<div style={{ height: 44, display: "flex", alignItems: "center", opacity: outOp }}>
					<Box style={{ maxWidth: 360, fontSize: 16 }}>
						<Typed text="Could you send the file when you have a moment?" from={104} dur={34} />
					</Box>
				</div>
			</div>
			<Caption items={["Select any text", "Hotkey → transform", "Rewritten in place"]} />
		</Stage>
	);
}
