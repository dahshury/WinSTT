import { Button as BaseButton } from "@base-ui/react/button";
import { domMax, LazyMotion, m, type Variants } from "motion/react";
import { useEffect, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	AudioVisualizer,
	useVisualizerStore,
} from "@/features/audio-visualizer";
import { ttsSetSpeed } from "@/shared/api/ipc-client";
import { Spinner } from "@/shared/ui/spinner";
import {
	DynamicIsland,
	DynamicIslandProvider,
	useDynamicIslandSize,
} from "@/shared/ui/dynamic-island";
import {
	discardTts,
	getTtsLevel,
	pauseTts,
	resumeTts,
	type TtsPlaybackStatus,
	useTtsPlaybackStore,
} from "../model/tts-playback-store";
import {
	CHIP_SHADOW,
	GLASS_SURFACE,
	OVERLAY_PANEL_CLOSE_MS,
	useDelayedUnmount,
} from "./overlay-shell";

/**
 * SVG glyph for a TTS pill control. `pause`/`play` are filled; `discard` is the
 * same X stroke as {@link CancelButton}.
 */
function IslandControlGlyph({
	kind,
	size,
}: {
	kind: "pause" | "play" | "discard";
	size: number;
}) {
	if (kind === "discard") {
		return (
			<svg
				aria-hidden="true"
				className="relative"
				fill="none"
				height={size}
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth={2}
				viewBox="0 0 24 24"
				width={size}
				xmlns="http://www.w3.org/2000/svg"
			>
				<line x1="6" x2="18" y1="6" y2="18" />
				<line x1="6" x2="18" y1="18" y2="6" />
			</svg>
		);
	}
	if (kind === "play") {
		return (
			<svg
				aria-hidden="true"
				className="relative"
				fill="currentColor"
				height={size}
				viewBox="0 0 24 24"
				width={size}
				xmlns="http://www.w3.org/2000/svg"
			>
				<path d="M8 5v14l11-7z" />
			</svg>
		);
	}
	return (
		<svg
			aria-hidden="true"
			className="relative"
			fill="currentColor"
			height={size}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect height="14" rx="1" width="4" x="6" y="5" />
			<rect height="14" rx="1" width="4" x="14" y="5" />
		</svg>
	);
}

/**
 * Glass control button for the read-aloud pill — pause / resume / discard. Same
 * capsule material as {@link CancelButton} so the controls read as siblings.
 */
function IslandControlButton({
	kind,
	label,
	onClick,
	size = 18,
}: {
	kind: "pause" | "play" | "discard";
	label: string;
	onClick: () => void;
	size?: number;
}) {
	return (
		<BaseButton
			aria-label={label}
			className={`pointer-events-auto relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-white/75 transition-colors hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={onClick}
			style={{ width: size, height: size, boxSizing: "border-box" }}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 rounded-full bg-white/0 transition-colors duration-150 hover:bg-white/[0.08]"
			/>
			<IslandControlGlyph kind={kind} size={Math.round(size * 0.5)} />
		</BaseButton>
	);
}

// Read-aloud speed steps per source. Local Kokoro accepts 0.5–2.0; ElevenLabs
// clamps `voice_settings.speed` to 0.7–1.2. Mirrors `electron/ipc/tts-reader.ts`
// (separate runtimes can't share the const); the reference re-clamps defensively.
const TTS_LOCAL_SPEEDS = [1, 1.25, 1.5, 2] as const;
const TTS_CLOUD_SPEEDS = [0.9, 1, 1.1, 1.2] as const;

function nextTtsSpeed(current: number, cloud: boolean): number {
	const steps = cloud ? TTS_CLOUD_SPEEDS : TTS_LOCAL_SPEEDS;
	const idx = steps.findIndex((s) => Math.abs(s - current) < 0.001);
	if (idx !== -1) {
		return steps[(idx + 1) % steps.length] ?? current;
	}
	return steps.find((s) => s > current) ?? steps[0] ?? current;
}

/**
 * Speed pill — shows the current read-aloud rate (e.g. `1.5Ã—`) and cycles to the
 * next step on tap. The new speed applies to the read's UPCOMING sentences
 * (natural pitch) and is persisted by the main process.
 */
function formatTtsSpeed(speed: number): string {
	return `${speed}x`;
}

function SpeedButton({ speed, cloud }: { speed: number; cloud: boolean }) {
	const label = formatTtsSpeed(speed);
	return (
		<BaseButton
			aria-label={`Reading speed ${label}, tap to change`}
			className={`pointer-events-auto flex h-[18px] shrink-0 items-center justify-center rounded-full px-1.5 font-medium text-[10px] text-white/75 tabular-nums transition-colors hover:text-white focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={() => ttsSetSpeed(nextTtsSpeed(speed, cloud))}
			title={`Reading speed ${label}`}
			type="button"
		>
			{label}
		</BaseButton>
	);
}

/**
 * Forced dynamic-island pill for a TTS read-aloud — a live visualiser of the
 * spoken audio (fed via the shared visualiser store by `useTtsIslandBridge`)
 * plus speed / pause-resume / discard controls. Fixed `compactMedium` footprint
 * so it stays compact ("doesn't grow much"). pause/resume/discard are local to
 * this window's queue; discard also cancels the server-side run; speed is routed
 * to the reader via IPC.
 */
function TtsIslandPill({ status }: { status: TtsPlaybackStatus }) {
	const { setSize, state } = useDynamicIslandSize();
	if (state.size !== "compactMedium") {
		setSize("compactMedium");
	}
	const cloud = useSettingsStore((s) => s.settings.tts?.source) === "cloud";
	const speed = useSettingsStore((s) =>
		cloud ? (s.settings.tts?.cloud?.speed ?? 1) : (s.settings.tts?.speed ?? 1),
	);
	const loading = status === "loading";
	const paused = status === "paused";
	return (
		<DynamicIsland
			className="pointer-events-auto"
			data-overlay-hit-region="true"
			flatTop
			id="winstt-tts-island"
		>
			<div className="flex h-full items-center justify-between gap-2 px-4">
				<div className="flex items-center">
					{loading ? (
						<div className="flex size-6 items-center justify-center text-white/70">
							<Spinner
								aria-label="Generating speech"
								className="size-3 border-[1.5px]"
							/>
						</div>
					) : paused ? (
						<div className="flex size-6 items-center justify-center text-white/60">
							<IslandControlGlyph kind="pause" size={12} />
						</div>
					) : (
						<AudioVisualizer size="icon" />
					)}
				</div>
				<div className="pointer-events-auto flex items-center gap-2">
					<SpeedButton cloud={cloud} speed={speed} />
					{loading ? null : (
						<IslandControlButton
							kind={paused ? "play" : "pause"}
							label={paused ? "Resume reading" : "Pause reading"}
							onClick={paused ? resumeTts : pauseTts}
						/>
					)}
					<IslandControlButton
						kind="discard"
						label={loading ? "Cancel speech generation" : "Stop reading"}
						onClick={discardTts}
					/>
				</div>
			</div>
		</DynamicIsland>
	);
}

// Panel-reveal for the TTS island (transitions.dev "panel reveal", from the
// top): slides down from the top bezel, cross-fading opacity and blur on one
// ease. Asymmetric durations (slower open, snappier close) mirror Apple's notch
// feel. The island is ALWAYS mounted and animates between `open`/`closed` — a
// property transition on a persistent element ALWAYS plays both directions,
// unlike an AnimatePresence unmount-exit (which can be dropped by React 19's
// unmount timing AND, sliding up into the top-edge clip, reads as an instant
// vanish). `y` is a % of the island's own height.
const TTS_PANEL_EASE = [0.22, 1, 0.36, 1] as const;
const TTS_PANEL_CLOSED_Y = "-50%";
const ttsPanelVariants: Variants = {
	closed: {
		y: TTS_PANEL_CLOSED_Y,
		opacity: 0,
		filter: "blur(2px)",
		transition: { duration: 0.35, ease: TTS_PANEL_EASE },
	},
	open: {
		y: 0,
		opacity: 1,
		filter: "blur(0px)",
		transition: { duration: 0.4, ease: TTS_PANEL_EASE },
	},
};

/**
 * Layer hosting the forced TTS read-aloud island. The island slides in AND out
 * from the top by animating a persistent element between `open`/`closed`; it's
 * mounted only while open + during the close (`useDelayedUnmount`) so its
 * visualiser never runs at rest. The overlay window is kept composited through
 * the close by `hideOverlay({ forceGrace: true })` in `tts.ts`. Top-anchored +
 * click-through container (only the controls capture pointer events).
 */
function TtsIslandLayer({
	show,
	status,
}: {
	show: boolean;
	status: TtsPlaybackStatus;
}) {
	const mounted = useDelayedUnmount(show, OVERLAY_PANEL_CLOSE_MS);
	return (
		<LazyMotion features={domMax} strict>
			<div className="pointer-events-none fixed inset-x-0 top-0 flex justify-center overflow-hidden">
				{mounted && (
					<m.div
						animate={show ? "open" : "closed"}
						initial="closed"
						variants={ttsPanelVariants}
					>
						<DynamicIslandProvider initialSize="compactMedium">
							<TtsIslandPill status={status} />
						</DynamicIslandProvider>
					</m.div>
				)}
			</div>
		</LazyMotion>
	);
}

/**
 * Bridges the overlay's TTS playback into the visuals: (1) feeds the shared
 * `useVisualizerStore.audioLevel` the live RMS off the TTS analyser each frame
 * while a read plays and STT is not active; (2) pauses read-aloud playback while
 * dictation owns the microphone without cancelling the TTS request. The TTS
 * island remains available so the user can resume after dictation.
 */
function useTtsIslandBridge(sessionActive: boolean): void {
	const status = useTtsPlaybackStore((s) => s.status);
	const setAudioLevel = useVisualizerStore((s) => s.setAudioLevel);
	const rafRef = useRef(0);

	useEffect(() => {
		if (sessionActive && status === "speaking") {
			pauseTts();
		}
	}, [sessionActive, status]);

	useEffect(() => {
		const playing = status === "speaking" && !sessionActive;
		if (!playing) {
			setAudioLevel(0);
			cancelAnimationFrame(rafRef.current);
			return;
		}
		const tick = () => {
			setAudioLevel(getTtsLevel());
			rafRef.current = requestAnimationFrame(tick);
		};
		rafRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafRef.current);
	}, [status, sessionActive, setAudioLevel]);
}

export { TtsIslandLayer, useTtsIslandBridge };
