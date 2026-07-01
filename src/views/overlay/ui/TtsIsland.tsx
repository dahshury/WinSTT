import { Button as BaseButton } from "@base-ui/react/button";
import { domMax, LazyMotion, m, type Variants } from "motion/react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	AudioVisualizer,
	useVisualizerStore,
} from "@/features/audio-visualizer";
import { ttsSetSpeed } from "@/shared/api/ipc-client";
import {
	clampTtsSpeed,
	nextTtsSpeedPreset,
	ttsSpeedPresets,
} from "@/shared/config/tts-speed";
import { formatTime } from "@/shared/lib/format-time";
import { Spinner } from "@/shared/ui/spinner";
import {
	DynamicIsland,
	DynamicIslandProvider,
} from "@/shared/ui/dynamic-island";
import {
	discardTts,
	getTtsLevel,
	getTtsProgress,
	pauseTts,
	resumeTts,
	seekTts,
	type TtsPlaybackStatus,
	useTtsPlaybackStore,
} from "../model/tts-playback-store";
import {
	CHIP_SHADOW,
	GLASS_SURFACE,
	OVERLAY_PANEL_CLOSE_MS,
	useDelayedUnmount,
} from "./overlay-shell.shared";
import { TtsSeekBar } from "./TtsSeekBar";
import { TtsVolumeControl } from "./TtsVolumeControl";

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
			className={`pointer-events-auto relative flex shrink-0 items-center justify-center overflow-hidden rounded-full text-overlay-foreground/75 transition-colors hover:text-overlay-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-overlay-foreground/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={onClick}
			style={{ width: size, height: size, boxSizing: "border-box" }}
			type="button"
		>
			<span
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 rounded-full bg-overlay-foreground/0 transition-colors duration-150 hover:bg-overlay-foreground/[0.08]"
			/>
			<IslandControlGlyph kind={kind} size={Math.round(size * 0.5)} />
		</BaseButton>
	);
}

/**
 * Speed pill — shows the current read-aloud rate (e.g. `1.5×`) and cycles to the
 * next preset on tap. The new speed applies to the read's UPCOMING sentences
 * (natural pitch) and is persisted by the main process (`tts_set_speed`). The
 * preset list is per-model (`ttsSpeedPresets`) so it never offers a speed the
 * engine would clamp/truncate — e.g. Supertonic drops the 2× step.
 */
function formatTtsSpeed(speed: number): string {
	return `${speed}x`;
}

function SpeedButton({
	speed,
	cloud,
	model,
}: {
	speed: number;
	cloud: boolean;
	model: string | undefined;
}) {
	const label = formatTtsSpeed(speed);
	const presets = ttsSpeedPresets(model, cloud);
	return (
		<BaseButton
			aria-label={`Reading speed ${label}, tap to change`}
			className={`pointer-events-auto flex h-[18px] shrink-0 items-center justify-center rounded-full px-1.5 font-medium text-[10px] text-overlay-foreground/75 tabular-nums transition-colors hover:text-overlay-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-overlay-foreground/40 ${GLASS_SURFACE} ${CHIP_SHADOW}`}
			onClick={() => ttsSetSpeed(nextTtsSpeedPreset(speed, presets))}
			title={`Reading speed ${label}`}
			type="button"
		>
			{label}
		</BaseButton>
	);
}

// Formatted-time cache (adapted from the media-player reference): the labels
// floor to whole seconds, so formatting is reused across frames and the label
// nodes re-render at most once per second.
const timeLabelCache = new Map<number, string>();
function fmt(seconds: number): string {
	const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	let label = timeLabelCache.get(whole);
	if (label === undefined) {
		// Cheap guard so a very long read can't grow the cache unbounded.
		if (timeLabelCache.size > 256) {
			timeLabelCache.clear();
		}
		label = formatTime(whole * 1000);
		timeLabelCache.set(whole, label);
	}
	return label;
}

/**
 * Forced dynamic-island pill for a TTS read-aloud — a compact media player:
 *   - Row 1: play / pause, a live visualiser of the spoken audio (fed via the
 *     shared visualiser store by `useTtsIslandBridge`), speed, volume, and stop.
 *   - Row 2: a seek bar flanked by elapsed / total time — revealed once playback
 *     starts (`duration > 0`); `fitContent` animates the height growth.
 *
 * All controls are local to this window's queue (discard also cancels the
 * server-side run; speed is routed to the reader via IPC). The island grows to
 * the `long` width and self-sizes its height so it stays a single row during
 * synthesis and only expands to two rows while audio plays.
 */
function TtsIslandPill({ status }: { status: TtsPlaybackStatus }) {
	const cloud = useSettingsStore((s) => s.settings.tts?.source) === "cloud";
	const model = useSettingsStore((s) => s.settings.tts?.model);
	const rawSpeed = useSettingsStore((s) =>
		cloud ? (s.settings.tts?.cloud?.speed ?? 1) : (s.settings.tts?.speed ?? 1),
	);
	// Clamp the local display to the model's supported range so a stale persisted
	// value above the new ceiling (e.g. an old 1.5 on Supertonic) shows the value
	// the engine actually plays, not a phantom faster rate. Cloud has its own
	// provider clamp and isn't model-scoped here.
	const speed = cloud ? rawSpeed : clampTtsSpeed(model, rawSpeed);
	const currentTime = useTtsPlaybackStore((s) => s.currentTime);
	const duration = useTtsPlaybackStore((s) => s.duration);
	const bufferedEnd = useTtsPlaybackStore((s) => s.bufferedEnd);
	const loading = status === "loading";
	const paused = status === "paused";
	const showSeek = !loading && duration > 0;
	return (
		<DynamicIsland
			className="pointer-events-auto"
			data-overlay-hit-region="true"
			fitContent
			flatTop
			id="winstt-tts-island"
			size="long"
		>
			<div className="flex flex-col gap-2 px-4 py-3">
				{/* Row 1 — transport */}
				<div className="flex items-center gap-2.5">
					<div className="flex shrink-0 items-center">
						{loading ? (
							<div className="flex size-[22px] items-center justify-center text-overlay-foreground/70">
								<Spinner
									aria-label="Generating speech"
									className="size-3 border-[1.5px]"
								/>
							</div>
						) : (
							<IslandControlButton
								kind={paused ? "play" : "pause"}
								label={paused ? "Resume reading" : "Pause reading"}
								onClick={paused ? resumeTts : pauseTts}
								size={22}
							/>
						)}
					</div>
					<div className="flex min-w-0 flex-1 items-center justify-center">
						{loading ? null : paused ? (
							<div className="flex h-6 items-center justify-center text-overlay-foreground/55">
								<IslandControlGlyph kind="pause" size={12} />
							</div>
						) : (
							<AudioVisualizer size="icon" />
						)}
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<SpeedButton cloud={cloud} model={model} speed={speed} />
						<TtsVolumeControl />
						<IslandControlButton
							kind="discard"
							label={loading ? "Cancel speech generation" : "Stop reading"}
							onClick={discardTts}
						/>
					</div>
				</div>
				{/* Row 2 — seek */}
				{showSeek ? (
					<div className="flex items-center gap-2 text-[10px] text-overlay-foreground/55">
						<span className="w-8 shrink-0 text-right font-mono tabular-nums">
							{fmt(currentTime)}
						</span>
						<TtsSeekBar
							bufferedEnd={bufferedEnd}
							className="flex-1"
							currentTime={currentTime}
							duration={duration}
							onSeek={seekTts}
						/>
						<span className="w-8 shrink-0 font-mono tabular-nums">
							{fmt(duration)}
						</span>
					</div>
				) : null}
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
						<DynamicIslandProvider initialSize="long">
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
	const setProgress = useTtsPlaybackStore((s) => s.setProgress);
	const setAudioLevel = useVisualizerStore((s) => s.setAudioLevel);
	const rafRef = useRef(0);
	const pausePlayback = useEffectEvent(() => {
		pauseTts();
	});

	useLayoutEffect(() => {
		if (sessionActive && status === "speaking") {
			pausePlayback();
		}
	}, [sessionActive, status]);

	useEffect(() => {
		const playing = status === "speaking" && !sessionActive;
		if (!playing) {
			setAudioLevel(0);
			cancelAnimationFrame(rafRef.current);
			return;
		}
		// One rAF feeds BOTH the visualiser level and the media-player progress
		// (current / duration / buffered). While paused the position is frozen and
		// kept correct by the last frame + optimistic `seekTts`, so we don't spin a
		// loop at rest.
		const tick = () => {
			setAudioLevel(getTtsLevel());
			const progress = getTtsProgress();
			setProgress(
				progress.currentTime,
				progress.duration,
				progress.bufferedEnd,
			);
			rafRef.current = requestAnimationFrame(tick);
		};
		rafRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafRef.current);
	}, [status, sessionActive, setAudioLevel, setProgress]);
}

export { TtsIslandLayer, useTtsIslandBridge };
