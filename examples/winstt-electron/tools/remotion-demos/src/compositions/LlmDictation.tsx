import { useCurrentFrame } from "remotion";
import { Box, C, Caption, envelope, Pill, Stage, ThinkingDots, Typed } from "../theme";

/**
 * LLM cleanup over a dictation transcript. 3 beats over DUR=150 frames (5s):
 *   0–50   Raw transcription — a muted pill types the messy verbatim text
 *   50–100 Cleaning up…      — raw pill fades out, thinking dots fade in
 *   100–150 Polished         — a clean box types the tidied sentence
 * Three reserved vertical slots (raw pill / dots / clean box); only opacity
 * animates per beat so nothing shifts as the story advances.
 */
export function LlmDictation() {
	const f = useCurrentFrame();
	const rawOp = envelope(f, 2, 8, 48, 54);
	const dotsOp = envelope(f, 52, 58, 98, 104);
	const cleanOp = envelope(f, 100, 110, 9999, 9999);
	return (
		<Stage tag="LLM cleanup · Dictation">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
				<div style={{ height: 40, display: "flex", alignItems: "center", opacity: rawOp }}>
					<Pill style={{ background: C.surface1, color: C.fgMuted }}>
						<Typed text="um so the the meeting is at 3 pm i think" from={4} dur={26} style={{ color: C.fgMuted }} />
					</Pill>
				</div>
				<div style={{ height: 20, display: "flex", alignItems: "center", opacity: dotsOp }}>
					<ThinkingDots />
				</div>
				<div style={{ height: 44, display: "flex", alignItems: "center", opacity: cleanOp }}>
					<Box>
						<Typed text="The meeting is at 3 PM." from={104} dur={20} />
					</Box>
				</div>
			</div>
			<Caption items={["Raw transcription", "Cleaning up…", "Polished"]} />
		</Stage>
	);
}
