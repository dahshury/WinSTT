import { type ReactNode, useEffect, useState } from "react";
import { useSettingsStore } from "@/entities/setting";
import {
	RECORDING_MODE_COLOR_HEX,
	type RecordingMode,
} from "@/shared/config/recording-mode-color";
import { cn } from "@/shared/lib/cn";
import {
	resolveVisualizerConfig,
	type VisualizerConfig,
	type VisualizerType,
} from "../lib/audio-visualizer";
import {
	createVisualizerStore,
	type VisualizerStoreApi,
} from "../model/visualizer-store";
import { VisualizerStoreProvider } from "../model/visualizer-store-context";
import { AudioVisualizerAura } from "./AudioVisualizerAura";
import { AudioVisualizerBar } from "./AudioVisualizerBar";
import { AudioVisualizerGrid } from "./AudioVisualizerGrid";
import { AudioVisualizerRadial } from "./AudioVisualizerRadial";
import { AudioVisualizerWave } from "./AudioVisualizerWave";
import { demoSpeechLevel } from "./VisualizerTypePreview.helpers";

/**
 * A live miniature of a visualizer type for the Appearance → visualizer-style
 * switcher. This mounts the REAL visualizer components (bar/grid/radial at
 * `size="icon"`; the wave/aura WebGL shaders lazily, on first hover) inside a
 * sandboxed visualizer store, and — while the option is hovered — drives that
 * store with a synthetic speech envelope. The preview therefore animates
 * exactly like the real overlay does when the user speaks, because it IS the
 * real component running its real animators; only the audio is synthesized.
 *
 * At rest nothing is driven: the store reads as idle ("disconnected"), which
 * is the same motionless look the real visualizer has when no audio is
 * happening. Only the hovered option animates — never the selected one.
 */
export interface VisualizerTypePreviewProps {
	/** True while the option is hovered/focused — drives the synthetic speech. */
	active: boolean;
	type: VisualizerType;
}

function prefersReducedMotion(): boolean {
	return (
		typeof globalThis.matchMedia === "function" &&
		globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * Feeds the sandbox store a fake speaking session while `active`; commits the
 * store back to idle (recordingStopped) the moment the hover ends.
 */
function useDemoSpeech(store: VisualizerStoreApi, active: boolean): void {
	useEffect(() => {
		if (!active || prefersReducedMotion()) {
			return;
		}
		store.getState().recordingStarted();
		store.getState().setSpeaking(true);
		let raf = requestAnimationFrame(function tick(now: number) {
			store.getState().setAudioLevel(demoSpeechLevel(now / 1000));
			raf = requestAnimationFrame(tick);
		});
		return () => {
			cancelAnimationFrame(raf);
			store.getState().recordingStopped();
		};
	}, [active, store]);
}

/**
 * Defers a WebGL preview (wave/aura) until its first hover, then keeps the
 * canvas mounted but `display:none` at rest — ReactShaderToy's
 * IntersectionObserver parks its draw loop for hidden canvases, so an idle
 * settings panel runs zero shader frames while re-hover resumes instantly
 * (no shader recompile). `restGlyph` stands in while the canvas is hidden.
 */
function LazyShaderPreview({
	active,
	restGlyph,
	children,
}: {
	active: boolean;
	children: ReactNode;
	restGlyph: ReactNode;
}) {
	const [warm, setWarm] = useState(false);
	useEffect(() => {
		if (active) {
			// react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- monotonic first-hover latch: `warm` records that this preview has been hovered at least once so the lazily-mounted WebGL canvas stays alive (hidden) for instant re-hover. It is memory of a past render (not a pure render derivation), and the only reactive input is the `active` prop — there is no event/subscription to move it behind. Adjusting it during render instead would just move the warning to react-doctor/no-adjust-state-on-prop-change.
			setWarm(true);
		}
	}, [active]);
	return (
		<>
			{warm ? (
				<span className={cn("flex", !active && "hidden")}>{children}</span>
			) : null}
			{active ? null : restGlyph}
		</>
	);
}

interface ShapePreviewProps {
	active: boolean;
	color: `#${string}`;
	config: VisualizerConfig;
}

/** Rest stand-in for the wave: its disconnected state IS a flat line. */
function WaveRestGlyph({ color }: { color: `#${string}` }) {
	return (
		<span className="mask-[linear-gradient(90deg,transparent_0%,black_20%,black_80%,transparent_100%)] flex h-[24px] w-[24px] items-center">
			<span
				className="h-[2px] w-full rounded-full"
				style={{ backgroundColor: color }}
			/>
		</span>
	);
}

/** Rest stand-in for the aura: a frozen frame of its idle blob. */
function AuraRestGlyph({ color }: { color: `#${string}` }) {
	return (
		<span className="flex h-[24px] w-[24px] items-center justify-center">
			<span
				className="size-[10px] rounded-full opacity-80 blur-[2px]"
				style={{ backgroundColor: color }}
			/>
		</span>
	);
}

function WavePreview({ active, color, config }: ShapePreviewProps) {
	return (
		<LazyShaderPreview
			active={active}
			restGlyph={<WaveRestGlyph color={color} />}
		>
			<AudioVisualizerWave
				blur={config.waveBlur}
				color={color}
				colorShift={config.waveColorShift}
				size="icon"
			/>
		</LazyShaderPreview>
	);
}

function AuraPreview({ active, color, config }: ShapePreviewProps) {
	return (
		<LazyShaderPreview
			active={active}
			restGlyph={<AuraRestGlyph color={color} />}
		>
			<AudioVisualizerAura
				bloom={config.auraBloom}
				blur={config.auraBlur}
				color={color}
				colorShift={config.auraColorShift}
				shape={config.auraShape}
				size="icon"
			/>
		</LazyShaderPreview>
	);
}

// Count/geometry knobs (bar count, grid rows/columns, radial dot count/radius)
// are deliberately NOT forwarded: they're tuned for the full-size overlay and
// don't scale down to a 24px glyph (e.g. 21 bars). Each component's own
// `size="icon"` defaults are used instead. Style knobs that read at any size
// (aura shape/blur/bloom, wave smoothing, color shift) are forwarded above.
function ShapePreview({
	type,
	...rest
}: ShapePreviewProps & { type: VisualizerType }) {
	switch (type) {
		case "grid":
			return (
				<AudioVisualizerGrid
					color={rest.color}
					interval={rest.config.gridInterval}
					size="icon"
				/>
			);
		case "radial":
			return <AudioVisualizerRadial color={rest.color} size="icon" />;
		case "wave":
			return <WavePreview {...rest} />;
		case "aura":
			return <AuraPreview {...rest} />;
		default:
			return <AudioVisualizerBar color={rest.color} size="icon" />;
	}
}

export function VisualizerTypePreview({
	type,
	active,
}: VisualizerTypePreviewProps) {
	// One isolated store per preview — hovering one option animates only it.
	const [store] = useState(createVisualizerStore);
	useDemoSpeech(store, active);

	const general = useSettingsStore((s) => s.settings.general);
	const recordingMode = (general?.recordingMode ?? "ptt") as RecordingMode;
	const color = RECORDING_MODE_COLOR_HEX[recordingMode] as `#${string}`;
	const config = resolveVisualizerConfig(general);

	return (
		<span
			aria-hidden="true"
			className="pointer-events-none flex shrink-0 items-center justify-center"
		>
			<VisualizerStoreProvider value={store}>
				<ShapePreview
					active={active}
					color={color}
					config={config}
					type={type}
				/>
			</VisualizerStoreProvider>
		</span>
	);
}
