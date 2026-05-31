import { useCurrentFrame } from "remotion";
import { Bars, C, Caption, envelope, Stage, Typed } from "../theme";

/**
 * Listen-mode composition. 3 beats over DUR=150 frames (5s):
 *   0–50    Captures system audio — speaker glyph + teal bars
 *   50–100  Live subtitles        — Speaker 1 line types in
 *   100–150 Diarized              — Speaker 2 line types in below
 * Both subtitle slots are reserved up front (fixed height, opacity-only) so
 * nothing shifts when the second speaker appears.
 */
export function Listen() {
	const f = useCurrentFrame();
	const sourceOp = envelope(f, 0, 6, 46, 54);
	const line1Op = envelope(f, 50, 58, 9999, 9999);
	const line2Op = envelope(f, 100, 108, 9999, 9999);
	return (
		<Stage tag="Listen">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
				<div style={{ height: 30, display: "flex", alignItems: "center", gap: 12, opacity: sourceOp }}>
					<span style={{ fontSize: 28, lineHeight: 1 }}>🔊</span>
					<Bars count={5} color={C.teal} />
				</div>
				<div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10, width: 300 }}>
					<div style={{ height: 22, display: "flex", alignItems: "baseline", gap: 8, opacity: line1Op }}>
						<span style={{ color: C.teal, fontWeight: 700, fontSize: 13 }}>Speaker 1</span>
						<Typed text="Let’s ship it." from={56} dur={14} style={{ fontSize: 16, color: C.fg }} />
					</div>
					<div style={{ height: 22, display: "flex", alignItems: "baseline", gap: 8, opacity: line2Op }}>
						<span style={{ color: C.teal, fontWeight: 700, fontSize: 13 }}>Speaker 2</span>
						<Typed text="Agreed — Friday." from={106} dur={16} style={{ fontSize: 16, color: C.fg }} />
					</div>
				</div>
			</div>
			<Caption items={["Captures system audio", "Live subtitles", "Diarized"]} />
		</Stage>
	);
}
