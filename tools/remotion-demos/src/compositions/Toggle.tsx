import { useCurrentFrame } from "remotion";
import { Bars, C, Caption, envelope, Keycap, MODE_COLOR, Pill, Stage, Typed } from "../theme";

/**
 * 3 beats over DUR=150 frames (5s):
 *   0–50   Tap to start  — keycap quick-presses, pill fades in with bars
 *   50–100 Keep talking   — two lines type & crossfade inside the pill
 *   100–150 Tap to stop    — keycap presses again, pill fades out
 * One press toggles a continuous hands-free session (no held key).
 * Reserve a fixed slot for every element (animate opacity, not layout).
 */
export function Toggle() {
	const f = useCurrentFrame();
	const tone = MODE_COLOR.toggle;
	// Quick taps: pressed right at the start beat and right at the stop beat.
	const pressed = f < 8 || (f >= 100 && f < 108);
	// Pill is up across beats 1–2, fades out on the stop tap.
	const pillOp = envelope(f, 4, 12, 108, 118);
	// Two thoughts share one text slot; crossfade between them.
	const line1Op = envelope(f, 56, 64, 80, 88);
	const line2Op = envelope(f, 84, 92, 9999, 9999);
	return (
		<Stage tag="Toggle">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
				<Keycap pressed={pressed}>tap</Keycap>
				<div style={{ height: 44, display: "flex", alignItems: "center", opacity: pillOp }}>
					<Pill style={{ borderColor: "rgba(250,204,21,0.32)", boxShadow: "0 0 26px -8px rgba(250,204,21,0.5)" }}>
						<Bars count={5} color={tone} active />
						<div style={{ position: "relative", width: 168, height: 22, fontSize: 15, color: C.fgMuted }}>
							<span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", opacity: line1Op }}>
								<Typed text="First thought…" from={56} dur={16} />
							</span>
							<span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", opacity: line2Op }}>
								<Typed text="…and the next one." from={82} dur={18} />
							</span>
						</div>
					</Pill>
				</div>
			</div>
			<Caption items={["Tap to start", "Keep talking", "Tap to stop"]} />
		</Stage>
	);
}
