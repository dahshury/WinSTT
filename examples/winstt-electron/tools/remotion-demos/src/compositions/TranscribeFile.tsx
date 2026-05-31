import { interpolate, useCurrentFrame } from "remotion";
import { C, Caption, ramp, Stage } from "../theme";

/** A small file card — an icon chip + filename. */
function FileCard({ icon, iconBg, name, sub, style }: { icon: string; iconBg: string; name: string; sub?: string; style?: React.CSSProperties }) {
	return (
		<div style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "9px 13px", borderRadius: 11, background: C.surface3, border: `1px solid ${C.border}`, ...style }}>
			<span style={{ width: 30, height: 30, borderRadius: 7, background: iconBg, color: "#fff", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, fontFamily: C.mono }}>
				{icon}
			</span>
			<span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
				<span style={{ fontSize: 14, color: C.fg }}>{name}</span>
				{sub ? <span style={{ fontSize: 11, color: C.fgMuted }}>{sub}</span> : null}
			</span>
		</div>
	);
}

/**
 * Transcribe a file — the drag-drop flow, made explicit. 3 beats over DUR:
 *   0–50    Drop an audio file  — interview.mp3 drops into a dashed drop zone
 *   50–100  Transcribing…       — a progress bar fills under it
 *   100–150 interview.srt saved — the .srt file pops in right beside the .mp3
 */
export function TranscribeFile() {
	const f = useCurrentFrame();
	const dropY = interpolate(ramp(f, 0, 18), [0, 1], [-34, 0]);
	const dropOp = ramp(f, 0, 12);
	const zoneActive = f < 22; // dashed zone "armed" during the drop
	const progress = ramp(f, 56, 96);
	const progressOp = f > 50 && f < 104 ? 1 : f >= 104 ? 0.25 : 0;
	const arrowOp = ramp(f, 100, 110);
	const srtPop = ramp(f, 102, 116);
	const srtScale = 0.9 + srtPop * 0.16 - ramp(f, 112, 122) * 0.06;
	const checkOp = ramp(f, 120, 130);

	return (
		<Stage tag="Transcribe a file">
			<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "16px 18px",
						borderRadius: 14,
						border: `2px dashed ${zoneActive ? C.accent : C.border}`,
						background: zoneActive ? C.accentSoft : "transparent",
						transition: "none",
					}}
				>
					{/* the dragged audio file */}
					<div style={{ transform: `translateY(${dropY}px)`, opacity: dropOp }}>
						<FileCard icon="♪" iconBg={C.accent} name="interview.mp3" sub="12:04 · 11 MB" />
					</div>
					{/* arrow — appears when the output is ready */}
					<span style={{ fontSize: 20, color: C.accent, opacity: arrowOp }}>→</span>
					{/* the generated transcript, beside the source */}
					<div style={{ opacity: srtPop, transform: `scale(${srtScale})`, position: "relative" }}>
						<FileCard icon="SRT" iconBg={C.success} name="interview.srt" sub="timestamped" />
						<span style={{ position: "absolute", top: -8, right: -8, width: 18, height: 18, borderRadius: "50%", background: C.success, color: "#04140a", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, opacity: checkOp }}>
							✓
						</span>
					</div>
				</div>
				{/* progress while transcribing */}
				<div style={{ width: 220, height: 5, borderRadius: 3, background: C.surface3, opacity: progressOp, overflow: "hidden" }}>
					<div style={{ width: `${progress * 100}%`, height: "100%", background: C.accent }} />
				</div>
			</div>
			<Caption items={["Drag in an audio file", "Transcribing…", "interview.srt saved beside it"]} />
		</Stage>
	);
}
